//! What "the same mutable resource" means in this agent, once (#1021).
//!
//! `#961` gives mutations of one resource a deterministic order through a keyed
//! lane, and that guarantee is only as wide as the key type is. It was not wide
//! enough here: the agent's two mutating paths — its connection to a central
//! Server, and its peer-to-peer listener — each declared their **own**
//! [`ResourceKey`], so a session mutated over one path and the same session
//! mutated over the other landed in two different lanes and could still
//! interleave. The lane was shared; the *key* was not.
//!
//! This module is the one declaration both paths key on. Each still uses only
//! the variants its own units need — nothing about a wire changed, and no
//! variant is reachable from a path that could not already name it — but because
//! `Session("work")` is now one value rather than two, a frame from either
//! socket keys the same bucket and the ordering the lint promises is a statement
//! about the session instead of about which socket happened to carry the frame.
//!
//! The key is **never inferred from the wire name**: that is the `extension.*`
//! -shaped guess the constraints rule out, and it would also be wrong in both
//! directions. On the central connection every unit names its target in a field
//! called `name`, whether that target is a tmux session or an env file. On the
//! peer-to-peer socket `agent.session.kill` takes a `name` and
//! `agent.file.delete` takes a `path`. Nothing about any of those wires says
//! which kind of thing it addresses, so the key is derived beside each arm, in
//! the same `core_routes!` / `p2p_routes!` invocation that declares everything
//! else about the unit.

use std::sync::Arc;

use nession_runtime::lane::{KeyedLane, Lanes as RuntimeLanes};

/// One mutable thing this agent owns, as a lane key.
///
/// The union of what the two paths can name. A variant used by one path is not
/// thereby reachable from the other — reachability is per-arm, declared with the
/// unit — and the type is deliberately not narrowed per path, because narrowing
/// it is what produced two keys and one missing invariant.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ResourceKey {
    /// A tmux session, by the name this agent knows it by.
    ///
    /// The one variant **both** paths use, and the reason this type exists: a
    /// session is one resource whichever socket a mutation of it arrives on.
    Session(String),
    /// A locally stored env file, by name.
    ///
    /// Distinct from `Session` rather than a bare `String`, because the two
    /// namespaces overlap: a session called `staging.env` and an env file called
    /// `staging.env` are not the same resource, and a string key would merge
    /// them.
    Env(String),
    /// The file sandbox as **one** resource, rather than a path within it.
    ///
    /// A deliberately coarse key. A path is not the whole of what a file
    /// mutation touches: a rename mutates two paths and a key can name only one;
    /// a recursive delete mutates a directory *and everything under it*, so a
    /// write of `dir/x` would be a different key while the tree it is in is
    /// being removed; and both `create-dir` and `write` create parents, so
    /// either may be making a path a queued mutation of a descendant is about to
    /// use. Multi-key acquisition would answer all three and costs a lock order,
    /// a parent-chain walk per frame, and a definition of what a key is on a
    /// hierarchical namespace. File mutations are not a throughput-critical
    /// path, and a session-key mistake is a stuck terminal, so this takes the
    /// coarse answer: every file mutation of this agent is ordered against every
    /// other.
    Filesystem,
    /// This agent's **P2P authority**, as one resource.
    ///
    /// The credentials it honours are agent-global state, and the only ordering
    /// that matters for them is against each other. A key of their own keeps a
    /// grant from queueing behind a session mutation — which matters more here
    /// than elsewhere, because a client's attach is *synchronously waiting* on
    /// the grant's acknowledgement: a grant stuck behind a slow `session.create`
    /// would be a browser attach stuck behind it too.
    Authority,
}

impl std::fmt::Display for ResourceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Session(name) => write!(f, "session:{name}"),
            Self::Env(name) => write!(f, "env:{name}"),
            Self::Filesystem => write!(f, "filesystem"),
            Self::Authority => write!(f, "authority"),
        }
    }
}

/// The lanes one connection's reader dispatches into, over this agent's keys.
///
/// One alias rather than one per path: two aliases over two key types is the
/// arrangement `#1021` removed, and an alias that exists in two places is a
/// place for a second key type to grow back.
pub type Lanes = RuntimeLanes<ResourceKey>;

/// The one mutation lane this **process** mutates through.
///
/// Built once, where the resources its keys name are built — one tmux server and
/// one file sandbox, both process-wide — and handed to every connection that
/// mutates them: the peer-to-peer listener's connections and the central
/// connection alike. See [`ResourceKey`] for what "the same resource" means and
/// `nession_runtime::lane::Lanes::shared` for what a shared lane buys.
///
/// No worker budget: what bounds how many resources are mutated at once is the
/// *connection's* admission bound, which is where the waiter is.
pub fn mutation_scheduler() -> Arc<KeyedLane<ResourceKey>> {
    // The bounds are the peer-to-peer path's, and deliberately unchanged: this
    // lane used to be that path's alone, so keeping its numbers is what makes
    // the sharing invisible to every existing connection. The central
    // connection's own admission bound is what bounds it, exactly as before.
    Arc::new(KeyedLane::new(
        crate::server::execution::DEFAULT_KEY_QUEUE_DEPTH,
        crate::server::execution::LANE_LABEL,
    ))
}
