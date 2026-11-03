//! Server-side environment-file management: storage, Session Environment
//! Binding state, and snapshot resolution.

pub mod binding;
pub mod store;

pub use binding::{BindingRecord, EnvBindingStore, MaterializedProfile, ObservedBindings};
pub use store::EnvStore;

use crate::db::Database;
use std::sync::Arc;

/// Bundles the server-side env store with the durable Session binding store and
/// its rebuildable observed cache, so a single `Arc` can be threaded through the
/// connection handlers.
pub struct EnvService {
    pub store: EnvStore,
    pub bindings: EnvBindingStore,
    pub observed: ObservedBindings,
}

impl EnvService {
    /// Construct the service backed by the given database.
    #[must_use]
    pub fn new(db: Arc<Database>) -> Arc<Self> {
        Arc::new(Self {
            store: EnvStore::new(Arc::clone(&db)),
            bindings: EnvBindingStore::new(Arc::clone(&db)),
            observed: ObservedBindings::new(),
        })
    }

    /// Forget every piece of state that named this Session. Desired binding is
    /// durable; observed is the cache that must not outlive the Session.
    pub async fn clear_session_state(&self, session_id: &str) {
        self.bindings.clear_session(session_id).await;
        self.observed.clear_session(session_id);
    }

    /// Forget an Agent's Sessions. Called when the Agent is removed; its live
    /// Sessions are gone with it.
    pub async fn clear_agent_state(&self, agent_id: &str) {
        self.bindings.clear_agent(agent_id).await;
        self.observed.clear_agent(agent_id);
    }
}
