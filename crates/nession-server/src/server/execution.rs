//! How one connection's frames are scheduled (`#961-C`).
//!
//! Before this module the read loop *was* the scheduler: `read.next()` →
//! `handle_message(..).await` → `read.next()`. A request that waited on an
//! agent therefore held every later frame on that connection behind it,
//! including requests that had nothing to do with it — and the protocol has
//! never needed that. A reply is matched by the envelope's `id`, so the
//! *position* of a reply carries nothing (see `docs/architecture/protocol.md`).
//!
//! What the serial loop did buy is ordering, and ordering is real — but for a
//! much smaller set of frames than it was applied to. So the loop keeps the
//! frames whose ordering is load-bearing for itself and hands the rest to a
//! lane, and which frames those are is **declared per Protocol Unit** in the
//! single `server_routes!` invocation (see [`ExecutionPolicy`] for why that is
//! the only place it can honestly live):
//!
//! | policy | frames | what the reader does |
//! |---|---|---|
//! | [`ExecutionPolicy::Ordered`] | `server.auth`, `server.agent.register`, `server.session.attach`, `server.relay.*` | waits for both lanes, then runs it — so it is applied, and answered, *after* everything read before it |
//! | [`ExecutionPolicy::Inline`] | every other unit, every control wire, every frame this Server only forwards, and anything that is not a protocol frame | runs it where it stands |
//! | [`ExecutionPolicy::Query`] | the read-only units | admits it to a bounded lane and reads the next frame |
//! | [`ExecutionPolicy::Key`] | the units that mutate a resource | queues it behind that resource's own queue and reads the next frame |
//!
//! ## The lanes themselves are shared, and so is one of them
//!
//! The reader's two lanes — bounded parallel reads, and one FIFO worker per
//! resource key — are the same mechanism the agent runs on both of its
//! connections, so they are one implementation rather than three:
//! [`nession_runtime::lane`]. What stays here is everything that is the
//! *Server's* answer rather than the mechanism's: its policy vocabulary, its
//! resource key, its derived keys, and its bounds.
//!
//! The two are not shared at the same scope, and that is the point of the
//! second half of `#961`'s review:
//!
//! | lane | scope | why |
//! |---|---|---|
//! | [`QueryLane`](nession_runtime::lane::QueryLane) | one per connection | it is admission, and what it protects is that connection's progress |
//! | key lane | **[`mutation_scheduler`] — one per runtime**, shared by every connection | it is *ordering*, and the resources it orders are the runtime's |
//!
//! A key lane per connection — what this was — ordered `same resource + same
//! connection`, which says nothing about the case the guarantee exists for: two
//! clients mutating one session are two frames on two sockets against one row of
//! one registry. The lane that orders them has to be the lane the registry
//! hangs off, so it is built where the registries and the env store are built
//! and passed to every connection.
//!
//! ## Why the ordered lane waits, and for how long
//!
//! The barrier in front of an `Ordered` frame is what keeps its guarantee
//! ("auth must take effect before the operations that depend on it") true in a
//! connection that is no longer serial. Without it, `before / auth / after`
//! written back to back would have the auth applied before the first query had
//! even been *scheduled* — the query would then be served by an authentication
//! it predates, and its refusal (or the auth's own reply) would arrive in an
//! order nothing could predict. It is bounded, because every query in flight is
//! bounded: each one is a handler that times out (10 s, 15 s, 3 s) rather than
//! waiting forever.
//!
//! ## Why the bound is a bound on the *reader*
//!
//! `Lanes::query` and `Lanes::key` wait when the lane they feed is full, and the
//! waiter is the read loop — so a connection that has filled a lane stops being
//! read from. That is the whole of #961's "no per-message unbounded
//! `tokio::spawn`": the tasks a connection may have in flight is a number, and
//! the way it is enforced is that the frame which would exceed it is not read
//! until there is room for it. The bound is per connection rather than
//! process-wide, because what it protects is the *connection's* ability to make
//! progress, and one busy browser must not consume the fleet's budget.
//!
//! A mutation now waits at *two* bounds, and they are per connection in the same
//! way: this connection's own admission slots
//! ([`DEFAULT_MUTATIONS_IN_FLIGHT`]) before its frame reaches the shared lane,
//! and that lane's per-key depth ([`DEFAULT_KEY_QUEUE_DEPTH`]) once it has. The
//! first is what makes the number of resources one peer can be mutating at once
//! a number; the second is what stops one peer from getting arbitrarily far
//! ahead of the agent acting on one resource.
//!
//! Waiting on a lane does not hold the connection's *writes*: the outbound path
//! is its own task with its own bound ([`crate::server::outbound`]), so a reader
//! parked on a full lane still has its ping written and its terminal frames
//! relayed.

use std::sync::Arc;

use tracing::{debug, error};

use crate::server::handler::{unit_policy, ConnectionHandler, HandlerAction};
use crate::server::outbound::WsMessageSender;
use nession_protocol::ProtocolMessage;
use nession_runtime::lane::KeyedLane;

/// The default number of queries one connection may have in flight.
///
/// Derived from the config field of the same name so the two cannot drift: a
/// deployment that sets `query_concurrency_per_connection` is choosing this
/// number. See `nession_runtime::lane::QueryLane` for what reaching it does.
pub const DEFAULT_QUERY_CONCURRENCY: usize =
    nession_common::config::DEFAULT_QUERY_CONCURRENCY_PER_CONNECTION;

/// How many mutations one connection of this Server may have in flight.
///
/// The bound that makes "tasks do not grow with unique keys" true here. Four
/// hundred resources each queued behind their own worker is four hundred tasks;
/// what this states is that a *connection* cannot have more than this many
/// mutations outstanding whichever resources it names, so the number of workers
/// its frames can create is a number ([`Lanes::shared`] takes the slots before
/// the work reaches the lane).
///
/// Sixteen rather than the query lane's `query_concurrency_per_connection`
/// because a mutation is not a query: a brokered `session.create` is a round
/// trip to an agent and back, so a client opening a workspace spends several
/// slots at once and a smaller bound would park it mid-workspace. It is also not
/// derived from the per-key depth ([`DEFAULT_KEY_QUEUE_DEPTH`], 8): the depth
/// says how far ahead of one resource a client may get, and this says how many
/// resources it may be ahead of at once. Two statements, two numbers.
///
/// The agent's peer-to-peer socket keeps its own number for the same reasons
/// `DEFAULT_KEY_QUEUE_DEPTH` states: a concurrency policy belongs to the runtime
/// that implements it (#961 constraints), and the two runtimes serve different
/// workloads.
pub const DEFAULT_MUTATIONS_IN_FLIGHT: usize = 16;

/// The mutation lane every connection of this Server dispatches into.
///
/// Built once, by whoever owns the resources its keys name — this Server's
/// registries and env store — and handed to each connection
/// ([`crate::server::websocket::ServerContext`]). It is *the runtime's* lane
/// rather than a connection's because the resources are the runtime's: two
/// clients mutating one session are mutating one row of one registry, and a lane
/// per connection would order neither against the other. See
/// [`ResourceKey`] and `nession_runtime::lane::Lanes::shared`.
///
/// No worker budget: what bounds how many resources are mutated at once is the
/// *connection's* admission bound ([`DEFAULT_MUTATIONS_IN_FLIGHT`]), which is
/// where the waiter is. See `nession_runtime::lane`.
pub fn mutation_scheduler() -> Arc<KeyedLane<ResourceKey>> {
    Arc::new(KeyedLane::new(DEFAULT_KEY_QUEUE_DEPTH, LANE_LABEL))
}

/// How many mutations one resource may have queued before the reader waits.
///
/// A *depth per key*, not a total: the bound that matters is "how far ahead of
/// the provider may one client get on one resource", and a total would let one
/// flooded session consume the budget of every other session on the connection.
/// Eight queued mutations for one session is already a client scripting a
/// session faster than the agent that owns it can act on it — a client that is
/// merely clicking in the UI never approaches it.
///
/// The agent's own socket states its own number for the same reason
/// (`nession-agent`'s `server::execution`), and the two are deliberately not
/// derived from one constant: a concurrency policy belongs to the runtime that
/// implements it (#961 constraints), and these are two runtimes with two
/// workloads.
pub const DEFAULT_KEY_QUEUE_DEPTH: usize = 8;

/// The name this Server's lanes put on their own log lines.
///
/// Empty because this runtime's lines read "query lane is full (…)" and there is
/// no other runtime's line for them to be mistaken for — see
/// `nession_runtime::lane`'s module docs.
pub const LANE_LABEL: &str = "";

/// The lanes one Server connection dispatches into.
///
/// [`Lanes`] itself is shared; this is the alias that fixes its key type to
/// *this* Server's resource key, so a call site names one type and the compiler
/// checks the key space it hands over. A connection builds one with
/// [`Lanes::shared`](nession_runtime::lane::Lanes::shared), handing it the
/// runtime's [`mutation_scheduler`].
pub type Lanes = nession_runtime::lane::Lanes<ResourceKey>;

/// The resource a mutation is ordered against.
///
/// A key is what makes two mutations "the same thing": same key, they run one
/// after the other in arrival order; different keys, they do not wait for each
/// other at all.
///
/// The variants name the *kind* of resource because the same string can be
/// both — an agent called `notes` and an env file called `notes` are not the
/// same resource, and a bare `String` key would merge them.
///
/// ## Where a key comes from
///
/// From the operation's own payload, in the same `server_routes!` arm that
/// declares the unit's policy — never from the wire name. `#961` states this
/// directly ("具体 key 规则应由 operation semantics 决定，而不是由 transport
/// 猜测"), and the payloads make the point on their own: `server.session.create`
/// names its target with an `agent_id` and a `name`, `server.session.kill` names
/// the *same* resource with one joined `session_id`, and nothing about either
/// wire says so. A transport that guessed would either merge the two spellings
/// (two keys for one session, and the create's ordering lost) or split them
/// wrongly.
///
/// The joined form is what the key uses, because the joined form is what the
/// session registry already calls that resource (`agent_id:session_name`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ResourceKey {
    /// A tmux session, by `agent_id:session_name`.
    Session(String),
    /// An env file, by the source it lives on and its name.
    Env(String),
}

impl std::fmt::Display for ResourceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Session(id) => write!(f, "session:{id}"),
            Self::Env(id) => write!(f, "env:{id}"),
        }
    }
}

/// How the reader dispatches one frame.
///
/// The policy is a property of the **Protocol Unit**, declared beside the unit
/// in the one `server_routes!` invocation that also produces the manifest and
/// the dispatcher — so a unit cannot be added without stating how it is
/// dispatched, and nothing here has to know what an `extension.*` wire is. The
/// requirement is explicit that the policy "must act on a Protocol Unit" and
/// must not be hardcoded as a prefix or a core special case; a table keyed by
/// what the Server serves is the difference between the two.
///
/// It is not shared with the agents' runtimes, and that is `#961-F`'s answer
/// rather than an omission: the variant sets differ (the agent's central
/// connection serves nothing ordered, so it has no `Ordered` at all), the
/// default for a frame nobody serves differs (both agents' peer-to-peer socket
/// and this Server answer it where it stands; the agent's central connection
/// gives it a lane), and each variant carries a key type of its own. One enum
/// would have to be everything to all three and could state none of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionPolicy {
    /// Serial, and ordered against everything already read on this connection:
    /// the frame is not run until the work in flight has finished.
    ///
    /// This is the lane for messages whose *effect* later frames depend on —
    /// authentication, agent registration, session attach, the relay mode
    /// transitions — and for the same reason it is the lane whose replies must
    /// not overtake the replies of frames read before it.
    Ordered,
    /// Serial, and not ordered against the work in flight: the reader runs it
    /// where it stands.
    ///
    /// Every frame that is *not* a unit lands here, and so does every unit that
    /// is not in the table above: a control wire, a wire this Server only
    /// forwards to an agent, a wire it does not serve at all, and anything that
    /// is not a protocol frame (a close, a ping, a binary blob). A forwarded
    /// wire is here on purpose — the Server cannot state a scheduling policy for
    /// a unit it does not own, and the honest default for a message whose
    /// semantics belong to someone else is the one that does not reorder it.
    Inline,
    /// Bounded parallel: admitted to the query lane, run on its own task, and
    /// answered whenever it finishes.
    ///
    /// **Read-only units only.** A query's handler runs against a *snapshot* of
    /// the connection ([`ConnectionHandler`] is cloned for it), so anything it
    /// changed about the connection itself would be changed in the snapshot and
    /// lost. It may of course read and write the shared registries — that is
    /// what a query does — but it answers, and it does nothing else: a `Close`
    /// or a `Relay` from a query is a declaration error and is logged as one.
    Query,
    /// A mutation: queued behind every other mutation of the same
    /// [`ResourceKey`], and independent of every other key's.
    ///
    /// "Every other mutation of the same key" is not "every other mutation of
    /// the same key *on this connection*": the lane is the runtime's
    /// ([`mutation_scheduler`]), so two clients mutating one session are queued
    /// against each other. Only the connection's admission bound
    /// ([`DEFAULT_MUTATIONS_IN_FLIGHT`]) is per connection, because only that is
    /// about what one peer may have in flight.
    ///
    /// Carries its key because the key is half of what the policy *is*: "how is
    /// this dispatched" cannot be answered for a mutation without saying what it
    /// is ordered against. Like a query, it runs against a snapshot of the
    /// connection, for the same reason and with the same consequence — a
    /// mutation a connection depends on (auth, register, attach, relay mode) is
    /// a connection transition and belongs on [`ExecutionPolicy::Ordered`], not
    /// here. Every unit declared `Key` today is a registry mutation
    /// (session create/kill), an agent mutation, or an env-file mutation, and
    /// none of them changes what this connection *is*.
    Key(ResourceKey),
}

/// The policy one wire is dispatched under.
///
/// A unit's policy comes from the declaration; anything else is
/// [`ExecutionPolicy::Inline`] — see that variant for why an undeclared wire is
/// not guessed at.
///
/// The payload is what a `Key` policy reads its resource out of, so this takes
/// it by reference: the same asymmetry the agent's `p2p_policy` has, and for the
/// same reason — the policy is read *before* the arm runs, and the arm consumes
/// the payload.
pub fn policy_for_wire(wire: &str, payload: &serde_json::Value) -> ExecutionPolicy {
    unit_policy(wire, payload).unwrap_or(ExecutionPolicy::Inline)
}

/// Run one lane's frame and answer it through the connection's reply lane.
///
/// One function for both lanes because the two differ in *when* they may run,
/// not in what they do with the handler. `lane` names the declaration in the
/// failure message, so a unit that answers with a connection action says which
/// of the two lanes it was declared on.
pub async fn answer(
    mut handler: ConnectionHandler,
    msg: ProtocolMessage<serde_json::Value>,
    sender: WsMessageSender,
    lane: &'static str,
) {
    match handler.handle_protocol_message(msg).await {
        Ok(HandlerAction::Reply(Some(reply))) => {
            // The reply lane waits for room and never drops, so the only error
            // here is the connection being over — in which case there is nobody
            // left to answer.
            if sender.send_reply(reply).await.is_err() {
                debug!("the connection ended before a lane's answer could be written");
            }
        }
        Ok(HandlerAction::Reply(None)) => {}
        Ok(HandlerAction::Close) | Ok(HandlerAction::Relay { .. }) => error!(
            "a unit declared as {lane} answered with a connection action; a lane runs \
             against a snapshot of the connection, so a connection transition has to be \
             declared `Ordered` — see `ExecutionPolicy`"
        ),
        Err(e) => error!("{lane} failed: {e:#}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A policy is read from the declaration, and an undeclared wire is not
    /// guessed at.
    ///
    /// The lane mechanics themselves are tested where they live
    /// (`nession_runtime::lane`); what is this runtime's to test is that the
    /// table here is what the reader reads, and what it does with a wire the
    /// table says nothing about.
    #[test]
    fn an_undeclared_wire_is_dispatched_inline() {
        let nothing = serde_json::json!({});
        assert_eq!(
            policy_for_wire("git.status", &nothing),
            ExecutionPolicy::Inline,
            "a wire this Server does not serve has no declaration to read"
        );
        assert_eq!(
            policy_for_wire("control.heartbeat", &nothing),
            ExecutionPolicy::Inline
        );
    }

    /// The two key spaces are told apart by the key, not by its text.
    ///
    /// A session named after an env file and the env file itself are not the
    /// same resource, and the lane would merge them if the key were the bare
    /// string — the kind of merge that shows up later as an unexplained stall on
    /// a session somebody happened to name after a file.
    #[test]
    fn the_two_key_spaces_have_distinct_spellings() {
        assert_ne!(
            ResourceKey::Session("staging.env".to_string()),
            ResourceKey::Env("staging.env".to_string())
        );
        assert_eq!(
            ResourceKey::Session("a:s1".to_string()).to_string(),
            "session:a:s1"
        );
        assert_eq!(
            ResourceKey::Env("a.env".to_string()).to_string(),
            "env:a.env"
        );
    }
}
