//! Server-side environment-file management: storage, usage tracking, and
//! snapshot resolution.

pub mod store;
pub mod usage;

pub use store::EnvStore;
pub use usage::EnvUsageRegistry;

use std::sync::Arc;

/// Bundles the server-side env store with the in-memory usage registry so a
/// single `Arc` can be threaded through the connection handlers.
pub struct EnvService {
    pub store: EnvStore,
    pub usage: EnvUsageRegistry,
}

impl EnvService {
    /// Construct the service rooted at the given server env directory.
    #[must_use]
    pub fn new(root: std::path::PathBuf) -> Arc<Self> {
        Arc::new(Self {
            store: EnvStore::new(root),
            usage: EnvUsageRegistry::new(),
        })
    }
}
