//! How one peer-to-peer connection's frames are scheduled (`#961-D`).
//!
//! Before this module the read loop *was* the scheduler, twice over: the
//! connection's reader awaited every handler where it stood, and the handlers
//! themselves reached for the connection's `SessionMap` mutex and held it
//! across their backend I/O. Two consequences, and they are different faults:
//!
//! * **Head of line.** A `file.read` parked on a slow file held the whole
//!   connection — every later frame, `control.ping` included, sat unread behind
//!   it. The protocol has never needed that: a reply is matched by the
//!   envelope's `id`, so the *position* of a reply carries nothing (see
//!   `docs/architecture/protocol.md`).
//! * **Ordering by accident.** The same lock made every resource serial with
//!   every other resource: session A's `terminal.input` waited on session B's
//!   attach, and neither of them was ordered against the third thing sharing
//!   the map. Per-session ordering was a side effect of holding one mutex, not
//!   a property anyone had stated.
//!
//! What replaces them is the pair of guarantees `#961` asks for, each with its
//! own mechanism:
//!
//! * **per-resource serialization** is the keyed lane — work is queued under a
//!   [`ResourceKey`], and one worker per key runs that key's work in the order
//!   the frames arrived. Keys are independent, so two sessions make progress at
//!   once.
//! * **no map lock across backend I/O** is structural on the other side of it:
//!   a session's backend hangs off `Arc<Mutex<..>>` in the map, so a frame takes
//!   the map lock only long enough to *find* the session
//!   (`server::websocket`'s `AttachedSession::backend`).
//!
//! ## The lanes themselves are shared, and so is one of them
//!
//! Both lanes are the same mechanism the Server's connections and this agent's
//! *central* connection run on, so there is one implementation rather than
//! three: [`nession_runtime::lane`]. What stays here is everything that is this
//! socket's answer rather than the mechanism's — its policy vocabulary, its
//! resource key, its derived keys, and its bounds.
//!
//! They are not shared at the same scope, and that is the second half of
//! `#961`'s review:
//!
//! | lane | scope | why |
//! |---|---|---|
//! | [`QueryLane`](nession_runtime::lane::QueryLane) | one per connection | it is admission, and what it protects is that connection's progress |
//! | key lane | **[`mutation_scheduler`] — one per agent**, shared by every peer-to-peer connection | it is *ordering*, and the resources it orders — the tmux server, the file sandbox — are the agent's |
//!
//! A key lane per connection — what this was — ordered `same resource + same
//! connection`, and the case this socket exists for is two browsers attaching to
//! one session: two frames on two sockets against one tmux session. The lane
//! that orders them has to be the lane the session manager hangs off, so it is
//! built where the session manager and the file sandbox are built
//! ([`crate::server::websocket::AgentServer::new`]) and handed to every
//! connection.
//!
//! ## The policies
//!
//! Which lane a wire goes to is a property of its **Protocol Unit**, declared
//! beside the arm that serves it in the one `p2p_routes!` invocation that also
//! produces the manifest and the dispatcher — the same column-on-the-row shape
//! the Server's `server_routes!` uses, for the same reason: a unit cannot be
//! handled without being advertised, or advertised without a lane, and nothing
//! here has to know what an `extension.*` wire is.
//!
//! ## The bounds
//!
//! Both lanes are bounded, and in both the thing that waits is the **reader**:
//! a frame that would exceed a bound is not *read* until there is room for it.
//! That is the whole of "no per-message unbounded `tokio::spawn`" — the tasks a
//! connection may have in flight is a number, and the number is enforced by not
//! reading past it. It is per connection rather than process-wide, because what
//! a bound protects is the *connection's* ability to make progress, and one busy
//! browser must not consume the fleet's budget.
//!
//! A mutation now waits at *two* bounds, and both wait in the same place — this
//! connection's reader, before the frame is read:
//!
//! * this connection's own admission slots ([`DEFAULT_MUTATIONS_IN_FLIGHT`]),
//!   taken before the frame reaches the shared lane. This is the bound that makes
//!   the number of resources one peer can be mutating at once a number, whatever
//!   keys it names.
//! * the shared lane's per-key depth ([`DEFAULT_KEY_QUEUE_DEPTH`]), reached once
//!   the frame is queued. This is the bound on how far ahead of one resource a
//!   peer may get — and because the lane is the agent's, the resource's queue is
//!   shared with every other connection, which is the point of it.
//!
//! Neither lane drops, because neither carries anything droppable: every frame
//! on them is a request with an `id` and a caller waiting for its answer, and
//! "the answer is never sent" is not a policy — it is a hang the peer cannot
//! tell from a slow agent. What *is* droppable on this socket is coalesced
//! elsewhere and deliberately (see `server::resize`).
//!
//! A key's queue being full therefore parks the reader, including for frames
//! bound for *other* keys. That is a real cost, and it is the one this design
//! accepts: at that point the connection is flooding one resource faster than
//! the agent can mutate it, and the alternative — buffering without limit — is
//! the failure mode this whole change exists to remove. The depth is large
//! enough ([`DEFAULT_KEY_QUEUE_DEPTH`]) that reaching it means the client is
//! genuinely ahead of the backend rather than merely bursty.

use std::sync::Arc;
use std::time::Duration;

use nession_runtime::lane::KeyedLane;

/// The default number of queries one peer-to-peer connection may have running.
///
/// Not a shared number with the Server's `query_concurrency_per_connection`:
/// that one is a deployment's answer for *its* connections, and the Server is a
/// different runtime with a different workload. A concurrency policy belongs to
/// the runtime that implements it (`#961` constraints), so this is the agent's
/// own answer, stated once here.
pub const DEFAULT_QUERY_CONCURRENCY: usize = 8;

/// How many mutations one resource may have queued before the reader waits.
///
/// A *depth per key*, not a total: the bound that matters is "how far ahead of
/// the backend may one client get on one resource", and a total would let one
/// flooded session consume the budget of every other session on the connection.
/// Sixteen `terminal.input` frames is well inside what a keystroke burst
/// produces, so a client that is merely typing never reaches this; a client
/// dribbling a paste at a rate the PTY cannot take is exactly who the bound is
/// for.
pub const DEFAULT_KEY_QUEUE_DEPTH: usize = 16;

/// How many mutations one peer-to-peer connection may have in flight.
///
/// The bound that makes "tasks do not grow with unique keys" true here. Without
/// it a peer naming a thousand sessions has a thousand keys and therefore a
/// thousand tasks, each inside its own per-key depth; what this states is that a
/// *connection* cannot have more than this many mutations outstanding whichever
/// resources it names, so the number of workers its frames can create is a
/// number ([`ExecutionLanes`]' shared lane takes the slots before the work
/// reaches the lane).
///
/// Sixteen, and per *connection* rather than per agent, for the reason
/// [`DEFAULT_KEY_QUEUE_DEPTH`] gives about fairness: the thing that waits is one
/// connection's reader, and a bound every peer shares is a budget one peer can
/// spend on behalf of the others. Sixteen is also this socket's per-key depth, so
/// a client that is merely far ahead of *one* session sees the same number on
/// both bounds; they are still two statements — how far ahead of one resource,
/// and how many resources at once.
pub const DEFAULT_MUTATIONS_IN_FLIGHT: usize = 16;

/// The mutation lane every peer-to-peer connection of this agent dispatches
/// into.
///
/// Built once, where the resources its keys name are built — one tmux server and
/// one file sandbox, both process-wide — and handed to every connection that
/// accepts on this socket ([`crate::server::websocket::AgentServer`]). See
/// [`ResourceKey`] for what "the same resource" means here, and
/// `nession_runtime::lane::Lanes::shared` for what a shared lane buys.
///
/// No worker budget: what bounds how many resources are mutated at once is the
/// *connection's* admission bound ([`DEFAULT_MUTATIONS_IN_FLIGHT`]), which is
/// where the waiter is. See `nession_runtime::lane`.
pub fn mutation_scheduler() -> Arc<KeyedLane<ResourceKey>> {
    Arc::new(KeyedLane::new(DEFAULT_KEY_QUEUE_DEPTH, LANE_LABEL))
}

/// How long a connection's lanes are given to stop when it ends.
///
/// The lanes are *aborted* rather than drained (see `Lanes::shutdown`), so this
/// is a ceiling on a wait that should not happen — a task stops at its first
/// await point after the abort — not a budget anything is expected to use.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// The name this socket's lanes put on their own log lines.
///
/// This agent runs two independent connections with two different failure
/// modes, so a bare "the lane is full" would not say which — see
/// `nession_runtime::lane`'s module docs.
pub const LANE_LABEL: &str = "peer-to-peer ";

/// The lanes one peer-to-peer connection reads into.
///
/// [`ExecutionLanes`] is shared; this is the alias that fixes its key type to
/// *this* socket's resource key, so a call site names one type and the compiler
/// checks the key space it hands over. A connection builds one with
/// [`ExecutionLanes::shared`](nession_runtime::lane::Lanes::shared), handing it
/// the agent's [`mutation_scheduler`].
pub type ExecutionLanes = nession_runtime::lane::Lanes<ResourceKey>;

/// The resource a mutation is ordered against.
///
/// A key is what makes two mutations "the same thing": same key, they run one
/// after the other in arrival order; different keys, they do not wait for each
/// other at all. The variants name the *kind* of resource because the same
/// string can be both — a session called `notes` and a file called `notes` are
/// not the same resource, and a bare `String` key would merge them.
///
/// The key is derived from the request payload, per unit, in the same
/// `p2p_routes!` invocation that declares everything else about the unit. It is
/// never inferred from the wire name: that is the `extension.*`-shaped guess the
/// constraints rule out, and it would also be wrong — `agent.session.kill` takes
/// a `name` field and `agent.file.delete` takes a `path`, and nothing about
/// either wire says so.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ResourceKey {
    /// A tmux session, by the name this agent knows it by.
    Session(String),
    /// **The file sandbox as one resource**, rather than a path within it.
    ///
    /// A deliberately coarse key, and the reason is that a path is not the whole
    /// of what a file mutation touches:
    ///
    /// * `agent.file.rename` mutates two paths — `from` and `to` — and a key can
    ///   name only one of them, so keyed by `from` a `write` of the destination
    ///   runs concurrently with the rename that is about to overwrite it;
    /// * recursive `agent.file.delete` mutates a directory *and everything under
    ///   it*, so keyed by the directory itself a `write` of `dir/x` is a
    ///   different key and the write lands in a tree that is being removed;
    /// * `agent.file.create-dir` and `agent.file.write` both create parents, so
    ///   either may be making a path a queued mutation of a *descendant* is
    ///   about to use.
    ///
    /// The alternative is multi-key acquisition — take the keys of every path a
    /// unit touches, in a fixed order — and it is more machinery than the
    /// ordering is worth: it needs a lock order to keep it deadlock-free, a
    /// parent-chain walk per frame, and an answer to what a key *is* on a
    /// hierarchical namespace (a prefix? a glob?). File mutations are also not a
    /// throughput-critical path — a UI's edits and an occasional bulk delete —
    /// while a session-key mistake is a stuck terminal. So the coarse answer,
    /// which is the direction `#961`'s review prefers: one key for the sandbox,
    /// and every file mutation of this agent is ordered against every other.
    ///
    /// What it costs is parallelism between *unrelated* file mutations: two
    /// browsers editing two different files now take turns where they did not.
    /// What it buys is that no two file mutations can interleave at all, which
    /// is what makes "a rename cannot race a write of its destination" and "a
    /// recursive delete cannot race a write of a descendant" properties of the
    /// design rather than of a path comparison that has to be right about
    /// symlinks, `..`, and trailing separators.
    ///
    /// Reads are untouched: `agent.file.list` and `agent.file.read` are queries
    /// on the connection's own lane and were never ordered against mutations.
    Filesystem,
}

impl std::fmt::Display for ResourceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Session(name) => write!(f, "session:{name}"),
            Self::Filesystem => write!(f, "filesystem"),
        }
    }
}

/// How the reader dispatches one frame.
///
/// Declared per Protocol Unit, beside the unit, in the one `p2p_routes!`
/// invocation — see this module's docs for why that is the only place it can
/// honestly live.
///
/// It is not shared with the other two runtimes, and that is `#961-F`'s answer
/// rather than an omission: each carries a key type of its own (this socket has
/// no env files, the agent's central connection has no files, the Server has
/// both), the agent's central connection has no `Ordered` variant at all, and
/// the default for a frame nobody serves is `Query` there and `Inline` here.
/// One enum would have to be everything to all three and could state none of
/// them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionPolicy {
    /// The frame is applied after everything read before it, including the work
    /// still running on both lanes.
    ///
    /// For the messages whose *effect* later frames depend on: this socket has
    /// exactly one, `client.auth`, which establishes the connection's identity.
    /// Without the barrier, `client.auth` written after a query would be applied
    /// before that query had even been scheduled, and the query would be served
    /// by an identity it predates. The barrier is bounded because everything it
    /// waits for is bounded — every query and every queued mutation finishes or
    /// fails.
    Ordered,
    /// Run where it stands, and answered when it finishes. The default for
    /// anything this socket does not serve, and for the arms whose whole body is
    /// a reply built from the request.
    Inline,
    /// Read-only: admitted to the query lane, run on its own task, answered
    /// whenever it finishes.
    Query,
    /// A mutation: queued behind every other mutation of the same
    /// [`ResourceKey`], and independent of every other key's.
    ///
    /// "Every other mutation of the same key" is not "every other mutation of
    /// the same key *on this connection*": the lane is the agent's
    /// ([`mutation_scheduler`]), so two browsers attaching to one session are
    /// queued against each other, and both are queued against a Server command
    /// that renames it. Only the connection's admission bound
    /// ([`DEFAULT_MUTATIONS_IN_FLIGHT`]) is per connection, because only that is
    /// about what one peer may have in flight.
    ///
    /// Every file mutation carries [`ResourceKey::Filesystem`] rather than a
    /// path — see that variant for why the key space is that coarse.
    Key(ResourceKey),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two key spaces are told apart by the key, not by its text.
    ///
    /// A session named after a path is not the file at that path, and the lane
    /// would merge them if the key were the bare string — the kind of merge that
    /// shows up later as an unexplained stall on a session somebody happened to
    /// name after a file.
    #[test]
    fn the_two_key_spaces_have_distinct_spellings() {
        assert_ne!(
            ResourceKey::Session("a/b.txt".to_string()),
            ResourceKey::Filesystem
        );
        assert_eq!(
            ResourceKey::Session("s1".to_string()).to_string(),
            "session:s1"
        );
        assert_eq!(ResourceKey::Filesystem.to_string(), "filesystem");
    }
}
