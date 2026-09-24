//! How one central-server connection's frames are scheduled (`#961-E`).
//!
//! Before this module the read loop was the *dispatcher*: every server message
//! became a detached `tokio::spawn`, which is the one shape `#961` rules out by
//! name ("禁止 per-message unbounded `tokio::spawn`"). What that bought was real
//! and is kept — a `tmux` command that takes ten seconds does not hold the
//! heartbeat or the next frame — but it bought it *unboundedly*: the number of
//! tasks an agent could be running tracked the number of messages a Server
//! chose to send, and an agent whose Server stopped waiting for answers grew a
//! task per command until something gave.
//!
//! What replaces it is a bounded executor with per-resource ordering:
//!
//! * **bounded** is the same mechanism both other runtimes in this change use
//!   (the Server's `server::execution`, this agent's own peer-to-peer
//!   `server::execution`): a frame that would exceed a lane is not *taken off
//!   the socket* until there is room for it. The tasks a connection can have in
//!   flight is a number, and the number is enforced by not reading past it.
//! * **per-resource ordering** is the keyed lane: work is queued under a
//!   [`ResourceKey`], and one worker per key runs that key's work in the order
//!   the frames arrived. Same key, serial and in order; different keys,
//!   independent.
//!
//! ## The lanes themselves are shared
//!
//! Both lanes are one implementation rather than three
//! ([`nession_runtime::lane`]). What stays here is everything that is *this*
//! connection's answer rather than the mechanism's — its policy vocabulary, its
//! resource key, its bounds, and the one bound no other runtime has (see
//! [`DEFAULT_KEY_WORKERS`]).
//!
//! ## The policies
//!
//! Which lane a wire goes to is a property of its **Protocol Unit**, declared
//! beside the arm that serves it in the one `core_routes!` invocation that also
//! produces the manifest and the dispatcher — the same column-on-the-row shape
//! the other two runtimes use, for the same reason: a unit cannot be handled
//! without being advertised, or advertised without a lane, and nothing here has
//! to know what an `extension.*` wire is.
//!
//! | policy | frames | what the reader does |
//! |---|---|---|
//! | [`ExecutionPolicy::Inline`] | the control wires, and nothing else | runs it where it stands |
//! | [`ExecutionPolicy::Query`] | the read-only units — the two lists, the env reads, the report, the capture | admits it to a bounded lane and reads on |
//! | [`ExecutionPolicy::Key`] | the mutations — session create/kill, session env apply/unset, env write/delete | queues it behind that resource's own queue and reads on |
//!
//! ## Why `Inline` is control and not the default
//!
//! This runtime's default is [`UNSERVED`], and it is *not* `Inline` — which is
//! where it differs from both other runtimes, and deliberately. What the Server
//! does not serve is a wire it only forwards; what *this* connection does not
//! serve is an extension's own command unit — a request the Server is waiting
//! for an answer to, whose handler reads files or walks a repository. Running
//! those where they stand is exactly the head-of-line blocking this stage
//! removes, so an unserved frame takes a bounded lane.
//!
//! A control wire is the opposite case: it is not an offer, nobody is waiting
//! for an answer to it, and its whole handler is a log line. It goes where it
//! stands, which is also the point of `#961`'s "control message 与普通 Protocol
//! Unit operation 分离" — a heartbeat must not be queued behind a session's
//! mutations.
//!
//! ## The bound, and what waits
//!
//! Both lanes are bounded, and in both the thing that waits is the **reader**.
//! Waiting there is only safe because the reader is not what writes to the
//! Server: the connection's socket is owned by a writer task
//! (`connection::server_client`'s `write_loop`) draining the outbox and the
//! response channel, so a reader parked on a full lane still sends heartbeats
//! and still writes the answers already computed. Before that split the single
//! loop did both jobs, and parking it on a bound would have stalled the
//! heartbeat — the one regression `#961` says must not happen.
//!
//! Neither lane drops: every frame on them is a request with an id and a Server
//! waiting for its answer, and "the answer is never sent" is not a policy — it
//! is a hang the peer cannot tell from a slow agent.
//!
//! A key's queue being full therefore parks the reader, including for frames
//! bound for *other* keys. That is a real cost, and it is the one this design
//! accepts: at that point the connection is flooding one resource faster than
//! this agent can mutate it, and the alternative — buffering without limit — is
//! the failure mode this whole change exists to remove.

use std::time::Duration;

/// The default number of queries one connection may have running.
///
/// Not a shared number with the peer-to-peer socket's
/// (`crate::server::execution::DEFAULT_QUERY_CONCURRENCY`), even though the two
/// are equal: a concurrency policy belongs to the runtime that implements it
/// (`#961` constraints), and the peer-to-peer socket serves browsers while this
/// one serves the Server. They are equal because both are "a handful of
/// independent reads in flight", not because one is derived from the other.
pub const DEFAULT_QUERY_CONCURRENCY: usize = 8;

/// How many mutations one resource may have queued before the reader waits.
///
/// A *depth per key*, not a total: the bound that matters is "how far ahead of
/// the backend may the Server get on one resource", and a total would let one
/// flooded session consume the budget of every other session on the connection.
/// Eight queued mutations for one session is already a Server scripting a
/// session faster than `tmux` can act on it.
pub const DEFAULT_KEY_QUEUE_DEPTH: usize = 8;

/// How many resources one central connection may have a worker running for.
///
/// [`DEFAULT_KEY_QUEUE_DEPTH`] bounds how far ahead of the backend the Server
/// may get on *one* resource; this bounds how many resources are being mutated
/// at once, and it is what makes "the tasks this connection has in flight" a
/// number rather than a function of how many distinct resources the Server
/// chooses to name. A per-key queue alone does not: a peer naming a thousand
/// sessions would have a thousand workers, one per key, each of them within its
/// own depth.
///
/// With [`DEFAULT_QUERY_CONCURRENCY`] this is the connection's whole in-flight
/// budget — eight read-only units running plus sixteen resources being mutated
/// — and `#961` asks for exactly that ("有明确 global in-flight limit"). The
/// bound waits where the others do: the reader parks until a key's worker has
/// finished.
///
/// Sixteen rather than eight because these are the units that *must* make
/// progress for the Server's view of the fleet to be right: a batch of session
/// creates for the sessions a browser is opening should not be half-serialised
/// behind each other.
///
/// **This runtime is the only one that has this bound**, and `#961-F` left it
/// that way rather than lifting it into the shared lane as a default: the
/// Server's own registry mutations and a browser's session mutations are keyed
/// by resources that are already few, and giving either a budget it did not have
/// would be a change in behaviour rather than a convergence. See
/// `nession_runtime::lane::KeyedLane::with_worker_budget`.
pub const DEFAULT_KEY_WORKERS: usize = 16;

/// How long a connection's lanes are given to stop when it ends.
///
/// The lanes are *aborted* rather than drained (see `Lanes::shutdown`), so this
/// is a ceiling on a wait that should not happen — a task stops at its first
/// await point after the abort — not a budget anything is expected to use.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// The name this connection's lanes put on their own log lines.
///
/// This agent runs two independent connections with two different failure
/// modes, so a bare "the lane is full" would not say which — see
/// `nession_runtime::lane`'s module docs.
pub const LANE_LABEL: &str = "central ";

/// The lanes one connection reads into.
///
/// [`Lanes`] is shared; this is the alias that fixes its key type to *this*
/// connection's resource key, so a call site names one type and the compiler
/// checks the key space it hands over.
pub type Lanes = nession_runtime::lane::Lanes<ResourceKey>;

/// The resource a mutation is ordered against.
///
/// A key is what makes two mutations "the same thing": same key, they run one
/// after the other in arrival order; different keys, they do not wait for each
/// other at all. The variants name the *kind* of resource because the same
/// string can be both — a session called `staging.env` and an env file called
/// `staging.env` are not the same resource, and a bare `String` key would merge
/// them.
///
/// The key is derived from the request payload, per unit, in the same
/// `core_routes!` invocation that declares everything else about the unit. It is
/// never inferred from the wire name: that is the `extension.*`-shaped guess the
/// constraints rule out, and it would also be wrong — every unit on this
/// connection names its target in a field called `name`, whether that target is
/// a tmux session or an env file, and nothing about either wire says which.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ResourceKey {
    /// A tmux session, by the name this agent knows it by.
    Session(String),
    /// A locally stored env file, by name.
    Env(String),
}

impl std::fmt::Display for ResourceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Session(name) => write!(f, "session:{name}"),
            Self::Env(name) => write!(f, "env:{name}"),
        }
    }
}

/// How the reader dispatches one frame.
///
/// Declared per Protocol Unit, beside the unit, in the one `core_routes!`
/// invocation — see this module's docs for why that is the only place it can
/// honestly live.
///
/// It has no `Ordered` variant, and that is this runtime's answer rather than an
/// omission: nothing on this connection establishes an identity or a mode that
/// later frames depend on, so there is no frame whose effect has to be ordered
/// against the work in flight. `#961-F` left the vocabulary here rather than
/// sharing one enum across the three runtimes — see
/// `crate::server::execution::ExecutionPolicy` for the rest of that argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionPolicy {
    /// Run where it stands, and answered when it finishes.
    ///
    /// The lane for the frames that are **not** operations: on this connection
    /// that is the control wires, whose reception is a log line. See this
    /// module's docs for why this is not the default here, where it is the
    /// default on both other runtimes.
    Inline,
    /// Read-only: admitted to the query lane, run on its own task, answered
    /// whenever it finishes.
    Query,
    /// A mutation: queued behind every other mutation of the same
    /// [`ResourceKey`], and independent of every other key's.
    Key(ResourceKey),
}

/// The lane a frame this connection does not serve is dispatched on.
///
/// See this module's docs: what this connection does not serve is an
/// extension's own command unit — a request the Server is waiting for an answer
/// to, whose handler does backend I/O — so it takes a bounded lane rather than
/// the reader.
///
/// It is the *query* lane rather than a lane of their own because a key is
/// something a unit declares and an extension declares none, and every
/// extension unit this agent composes today is read-only (`claude-code.list`,
/// `claude-code.read`, `git.status` and its siblings). An extension that grew a
/// **mutation** would be dispatched here unordered — a real hole, and also the
/// point at which the extension declaration has to grow a policy column. That
/// is a change to what a provider declares, which is not this stage's to make.
pub const UNSERVED: ExecutionPolicy = ExecutionPolicy::Query;

#[cfg(test)]
mod tests {
    use super::*;

    /// The two key spaces are told apart by the key, not by its text.
    ///
    /// Every unit on this connection names its target in a field called `name`,
    /// and what that name *means* is the unit's business: a session called after
    /// an env file and the env file itself are not the same resource, and the
    /// lane would merge them if the key were the bare string.
    #[test]
    fn the_two_key_spaces_have_distinct_spellings() {
        assert_ne!(
            ResourceKey::Session("staging.env".to_string()),
            ResourceKey::Env("staging.env".to_string())
        );
        assert_eq!(
            ResourceKey::Session("s1".to_string()).to_string(),
            "session:s1"
        );
        assert_eq!(
            ResourceKey::Env("a.env".to_string()).to_string(),
            "env:a.env"
        );
    }

    /// The default for a frame this connection does not serve is a lane, not
    /// where it stands — the one policy default that differs between the three
    /// runtimes, pinned so a later "convergence" cannot quietly make them agree.
    #[test]
    fn an_unserved_frame_is_not_dispatched_inline() {
        assert_eq!(UNSERVED, ExecutionPolicy::Query);
    }
}
