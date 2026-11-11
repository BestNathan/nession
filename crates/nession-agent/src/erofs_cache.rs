//! Agent adapter over the reusable EROFS cache (#3023, #3303).
//!
//! The durable download/resume/verify/publish/diagnostics/pin mechanics live
//! in [`nession_erofs::cache`]. This module supplies only what is Agent-owned:
//! the configured-root precedence resolved by
//! [`crate::config::AgentConfig::effective_erofs_storage_dir`] and the stable
//! Agent identity.

pub use nession_erofs::cache::{
    identity_root, CacheDiagnostics, CachedImage, DownloadGrant, ErofsCache, PinGuard,
    ProcMountsProbe, StorageProbe, IDENTITY_NAMESPACE_DIR, PARTIAL_RETENTION, TRANSFER_CHUNK_BYTES,
};

use crate::config::ResolvedErofsStorage;

/// Open the Agent's durable cache from its resolved storage configuration.
///
/// `ResolvedErofsStorage` comes only from
/// [`crate::config::AgentConfig::effective_erofs_storage_dir`], which owns the
/// TOML > environment > native-default precedence. `identity` is the stable
/// Agent identity (see [`crate::identity::resolve_agent_id`]); two Agent
/// processes with different identities on one volume never share ready or
/// partial files.
pub async fn open_resolved(
    resolved: &ResolvedErofsStorage,
    identity: &str,
) -> anyhow::Result<ErofsCache> {
    ErofsCache::open_with_probe(
        &resolved.path,
        identity,
        resolved.explicit,
        &ProcMountsProbe,
    )
    .await
}
