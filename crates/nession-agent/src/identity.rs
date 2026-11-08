//! Agent identity persistence.
//!
//! Resolves a stable agent identity across restarts by reading/writing
//! a plain-text file at `~/.nession/agent/identity`.
//!
//! Resolution order:
//! 1. A non-empty config `agent_id` is an explicit operator override: use it
//!    and overwrite the identity file if it differs.
//! 2. An empty config `agent_id` with a valid identity file: reuse the
//!    persisted id (this is the default-config startup, #2973).
//! 3. An empty config `agent_id` with no/empty/unreadable identity file:
//!    generate `agent-{uuid}`, persist it, and use it.
//!
//! The file is the source of truth for stability; a non-empty config value is
//! the source of truth for authority. Absence is not an identity: an empty id
//! is never persisted.

use anyhow::{Context, Result};
use std::path::Path;
use tracing::{info, warn};

/// Resolve the agent identity for this machine.
///
/// `config_agent_id` — the agent_id from AgentConfig. A non-empty value is an
/// explicit operator override and wins over the identity file. An empty value
/// means "not configured": the persisted identity is reused, or `agent-{uuid}`
/// is generated and persisted when no valid one exists.
/// `identity_path` — typically `nession_common::paths::agent_identity_path()?`.
///
/// Returns the resolved agent_id.
pub fn resolve_agent_id(config_agent_id: &str, identity_path: &Path) -> Result<String> {
    let persisted = if identity_path.exists() {
        load_identity(identity_path)
    } else {
        None
    };

    // A non-empty config value is the operator's explicit choice and is
    // authoritative — but only then. The default config leaves the id empty
    // precisely so that this branch is not taken on an ordinary restart
    // (#2973): a generated default used to arrive here and overwrite the
    // persisted identity with a new UUID every start.
    if !config_agent_id.is_empty() {
        match persisted {
            Some(file_id) if file_id == config_agent_id => {
                info!("Identity loaded from {identity_path:?}: {file_id}");
            }
            Some(file_id) => {
                info!(
                    "Config agent_id '{config_agent_id}' differs from persisted \
                     '{file_id}'; using config value"
                );
                persist_identity(identity_path, config_agent_id)?;
            }
            None => {
                persist_identity(identity_path, config_agent_id)?;
                info!("Persisted new agent identity: {config_agent_id}");
            }
        }
        return Ok(config_agent_id.to_string());
    }

    // No explicit id: reuse a valid persisted identity. This is what keeps a
    // default-config agent stable across restarts (#91, #2973).
    if let Some(file_id) = persisted {
        info!("Identity loaded from {identity_path:?}: {file_id}");
        return Ok(file_id);
    }

    if identity_path.exists() {
        warn!("Identity file at {identity_path:?} is empty or unreadable; regenerating");
    }
    let generated = format!("agent-{}", uuid::Uuid::new_v4());
    persist_identity(identity_path, &generated)?;
    info!("Persisted new agent identity: {generated}");
    Ok(generated)
}

/// Read the identity file, returning the trimmed id string or `None` if
/// the file is empty or unreadable.
fn load_identity(path: &Path) -> Option<String> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let trimmed = content.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
        Err(e) => {
            warn!("Failed to read identity file at {path:?}: {e}");
            None
        }
    }
}

/// Write the identity file, creating parent directories if needed.
fn persist_identity(path: &Path, agent_id: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory {parent:?}"))?;
    }
    std::fs::write(path, format!("{agent_id}\n"))
        .with_context(|| format!("failed to write identity file to {path:?}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Make the persisted file unwritable, so an attempted rewrite in the code
    /// under test fails instead of silently succeeding with identical bytes.
    fn freeze_identity_file(path: &std::path::Path) {
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    /// An absent config id must not mint a new identity when the state
    /// directory already holds one (#2973).
    ///
    /// This is the `config agent_id empty → reuse persisted` rule from the
    /// stable-identity design. The bug was that `AgentConfig::default()` never
    /// produced an absent id — it generated a fresh UUID, which looked like an
    /// operator override and overwrote the persisted one on every restart.
    #[test]
    fn an_absent_config_id_reuses_the_persisted_identity() {
        let dir = tempfile::tempdir().unwrap();
        let identity_path = dir.path().join("identity");
        std::fs::write(&identity_path, "agent-persisted\n").unwrap();
        freeze_identity_file(&identity_path);

        // A resolver that rewrites the file (even with the same bytes) now
        // fails instead of returning Ok.
        let id = resolve_agent_id("", &identity_path).unwrap();

        assert_eq!(id, "agent-persisted");
        assert_eq!(
            std::fs::read_to_string(&identity_path).unwrap().trim(),
            "agent-persisted"
        );
    }

    /// First default startup: no config id and no identity file → generate
    /// `agent-{uuid}`, persist it, and reuse it on the next startup. An empty
    /// id is never written as this agent's identity.
    #[test]
    fn an_absent_config_id_generates_and_persists_once() {
        let dir = tempfile::tempdir().unwrap();
        let identity_path = dir.path().join("identity");

        let first = resolve_agent_id("", &identity_path).unwrap();

        assert!(
            first.starts_with("agent-"),
            "a generated identity keeps the documented `agent-{{uuid}}` form: {first}"
        );
        assert_eq!(
            std::fs::read_to_string(&identity_path).unwrap().trim(),
            first
        );

        // The second startup must reuse, not rewrite: with the file unwritable
        // a rewrite would fail rather than return the id.
        freeze_identity_file(&identity_path);
        let second = resolve_agent_id("", &identity_path).unwrap();
        assert_eq!(second, first, "the second startup must reuse the identity");
        assert_eq!(
            std::fs::read_to_string(&identity_path).unwrap().trim(),
            first
        );
    }

    /// SC-01 at the identity owner's boundary: two consecutive default
    /// `AgentConfig` startups against one state directory resolve the same
    /// nonempty id, and the second does not replace it with a fresh UUID.
    #[test]
    fn two_default_startups_with_one_state_directory_resolve_the_same_identity() {
        use crate::config::AgentConfig;

        let dir = tempfile::tempdir().unwrap();
        let identity_path = dir.path().join("identity");

        let first_config = AgentConfig::default();
        let first = resolve_agent_id(&first_config.agent_id, &identity_path).unwrap();

        // Prove the restart only reads: an attempted rewrite of the unwritable
        // file fails instead of returning an id.
        freeze_identity_file(&identity_path);

        let second_config = AgentConfig::default();
        let second = resolve_agent_id(&second_config.agent_id, &identity_path).unwrap();

        assert!(!first.is_empty(), "a resolved identity must be nonempty");
        assert_eq!(
            second, first,
            "a restart changed the logical agent identity"
        );
        assert_eq!(
            std::fs::read_to_string(&identity_path).unwrap().trim(),
            first
        );
    }

    /// An empty identity file is "missing", not an identity: an absent config
    /// id regenerates and persists a valid one (#425's original concern).
    #[test]
    fn an_absent_config_id_regenerates_an_empty_identity_file() {
        let dir = tempfile::tempdir().unwrap();
        let identity_path = dir.path().join("identity");
        std::fs::write(&identity_path, "\n").unwrap();

        let id = resolve_agent_id("", &identity_path).unwrap();

        assert!(
            !id.is_empty(),
            "a blank file must not resolve to an empty id"
        );
        assert_eq!(std::fs::read_to_string(&identity_path).unwrap().trim(), id);
    }

    #[test]
    fn resolve_when_no_file_creates_and_uses_config_value() {
        let dir = tempfile::tempdir().unwrap();
        let identity_path = dir.path().join("identity");

        let id = resolve_agent_id("agent-custom", &identity_path).unwrap();
        assert_eq!(id, "agent-custom");
        let content = std::fs::read_to_string(&identity_path).unwrap();
        assert_eq!(content.trim(), "agent-custom");
    }

    #[test]
    fn resolve_when_file_exists_returns_file_value() {
        let dir = tempfile::tempdir().unwrap();
        let identity_path = dir.path().join("identity");
        std::fs::create_dir_all(identity_path.parent().unwrap()).unwrap();
        std::fs::write(&identity_path, "agent-persisted\n").unwrap();

        let id = resolve_agent_id("agent-persisted", &identity_path).unwrap();
        assert_eq!(id, "agent-persisted");
    }

    #[test]
    fn resolve_when_config_differs_config_wins_and_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let identity_path = dir.path().join("identity");
        std::fs::create_dir_all(identity_path.parent().unwrap()).unwrap();
        std::fs::write(&identity_path, "old-agent\n").unwrap();

        let id = resolve_agent_id("new-agent", &identity_path).unwrap();
        assert_eq!(id, "new-agent");
        let content = std::fs::read_to_string(&identity_path).unwrap();
        assert_eq!(content.trim(), "new-agent");

        // SC-02: the same explicit config stays stable on the next start.
        let again = resolve_agent_id("new-agent", &identity_path).unwrap();
        assert_eq!(again, "new-agent");
        assert_eq!(
            std::fs::read_to_string(&identity_path).unwrap().trim(),
            "new-agent"
        );
    }

    #[test]
    fn resolve_when_file_empty_regenerates() {
        let dir = tempfile::tempdir().unwrap();
        let identity_path = dir.path().join("identity");
        std::fs::create_dir_all(identity_path.parent().unwrap()).unwrap();
        std::fs::write(&identity_path, "\n").unwrap();

        let id = resolve_agent_id("agent-fresh", &identity_path).unwrap();
        assert_eq!(id, "agent-fresh");
        let content = std::fs::read_to_string(&identity_path).unwrap();
        assert_eq!(content.trim(), "agent-fresh");
    }

    #[test]
    fn resolve_persists_to_missing_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        // identity_path's parent (~/.nession/agent/) doesn't exist
        let identity_path = dir.path().join("subdir").join("identity");

        let id = resolve_agent_id("agent-nested", &identity_path).unwrap();
        assert_eq!(id, "agent-nested");
        assert!(identity_path.exists());
    }
}
