//! Agent identity persistence.
//!
//! Resolves a stable agent identity across restarts by reading/writing
//! a plain-text file at `~/.nession/agent/identity`.
//!
//! Resolution order:
//! 1. If the identity file exists and matches the config agent_id -> use it.
//! 2. If the identity file exists but config differs -> config wins (explicit
//!    override by the operator), overwrite file.
//! 3. No identity file -> persist the current config value and use it.
//!
//! The file is the source of truth for stability; config is the source of
//! truth for authority. On first run (config auto-generates a UUID or the
//! operator sets one), the identity is persisted.

use anyhow::{Context, Result};
use std::path::Path;
use tracing::{info, warn};

/// Resolve the agent identity for this machine.
///
/// `config_agent_id` — the agent_id from AgentConfig (always non-empty;
/// defaults to `agent-{uuid}` when not in config file).
/// `identity_path` — typically `nession_common::paths::agent_identity_path()?`.
///
/// Returns the resolved agent_id.
pub fn resolve_agent_id(config_agent_id: &str, identity_path: &Path) -> Result<String> {
    if identity_path.exists() {
        match load_identity(identity_path) {
            Some(file_id) => {
                if file_id == config_agent_id {
                    info!("Identity loaded from {identity_path:?}: {file_id}");
                    return Ok(file_id);
                }
                info!(
                    "Config agent_id '{config_agent_id}' differs from persisted \
                     '{file_id}'; using config value"
                );
                persist_identity(identity_path, config_agent_id)?;
                return Ok(config_agent_id.to_string());
            }
            None => {
                warn!(
                    "Identity file at {identity_path:?} is empty; regenerating"
                );
                persist_identity(identity_path, config_agent_id)?;
                return Ok(config_agent_id.to_string());
            }
        }
    }

    // No file — first run; persist current value.
    persist_identity(identity_path, config_agent_id)?;
    info!("Persisted new agent identity: {config_agent_id}");
    Ok(config_agent_id.to_string())
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
