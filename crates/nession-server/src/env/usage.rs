//! In-memory registry tracking which env files are applied to which sessions.
//!
//! Powers two features:
//! - **In-use lock (SC5/EC10):** an env file applied to a running session may
//!   not be edited until every using session releases it.
//! - **Visibility (SC4):** clients can see which env files are active on a
//!   session, their source, phase (create/attach), and who applied them.
//!
//! State is intentionally in-memory: create-time usage is released when the
//! session is destroyed, and attach-time usage when the client detaches. On a
//! server restart all sessions are re-synced as `recovering`, so stale locks
//! never outlive the process.

use nession_common::protocol::{ActiveEnvFile, EnvFileRef, EnvSource};
use std::collections::HashMap;
use std::sync::RwLock;

/// A single env-file application on a session.
#[derive(Debug, Clone)]
struct Usage {
    name: String,
    source: EnvSource,
    agent_id: Option<String>,
    /// "create" or "attach".
    phase: String,
    /// Identifier of the client that applied it (best-effort).
    applied_by: Option<String>,
}

impl Usage {
    fn to_active(&self) -> ActiveEnvFile {
        ActiveEnvFile {
            name: self.name.clone(),
            source: self.source,
            agent_id: self.agent_id.clone(),
            phase: self.phase.clone(),
            applied_by: self.applied_by.clone(),
        }
    }

    /// Whether this usage refers to the same file as `key`.
    fn matches(&self, key: &FileKey) -> bool {
        self.name == key.name && self.source == key.source && self.agent_id == key.agent_id
    }
}

/// Identity of an env file for lock checks (name + source + owning agent).
#[derive(Debug, Clone, PartialEq, Eq)]
struct FileKey {
    name: String,
    source: EnvSource,
    agent_id: Option<String>,
}

impl FileKey {
    fn from_ref(r: &EnvFileRef) -> Self {
        Self {
            name: r.name.clone(),
            source: r.source,
            agent_id: r.agent_id.clone(),
        }
    }
}

/// Tracks env-file usage across sessions.
pub struct EnvUsageRegistry {
    // session_id -> list of usages
    sessions: RwLock<HashMap<String, Vec<Usage>>>,
}

impl Default for EnvUsageRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl EnvUsageRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    /// Record env files applied to a session at create time.
    /// Skips files that already have a usage record for the same phase (idempotent).
    pub fn record_create(&self, session_id: &str, files: &[EnvFileRef], applied_by: Option<&str>) {
        let mut sessions = self
            .sessions
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = sessions.entry(session_id.to_string()).or_default();
        for f in files {
            let key = FileKey::from_ref(f);
            if entry.iter().any(|u| u.matches(&key) && u.phase == "create") {
                continue;
            }
            entry.push(Usage {
                name: f.name.clone(),
                source: f.source,
                agent_id: f.agent_id.clone(),
                phase: "create".to_string(),
                applied_by: applied_by.map(str::to_string),
            });
        }
    }

    /// Record env files applied to a session at attach time.
    /// Skips files that already have a usage record for the same phase (idempotent).
    pub fn record_attach(&self, session_id: &str, files: &[EnvFileRef], applied_by: Option<&str>) {
        let mut sessions = self
            .sessions
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = sessions.entry(session_id.to_string()).or_default();
        for f in files {
            let key = FileKey::from_ref(f);
            if entry.iter().any(|u| u.matches(&key) && u.phase == "attach") {
                continue;
            }
            entry.push(Usage {
                name: f.name.clone(),
                source: f.source,
                agent_id: f.agent_id.clone(),
                phase: "attach".to_string(),
                applied_by: applied_by.map(str::to_string),
            });
        }
    }

    /// Remove specific attach-time usages for a session (on detach).
    /// Only removes entries whose phase is "attach" and that match one of the
    /// given files (optionally scoped to the applying client).
    pub fn remove_attach(&self, session_id: &str, files: &[EnvFileRef], applied_by: Option<&str>) {
        let mut sessions = self
            .sessions
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(usages) = sessions.get_mut(session_id) {
            let keys: Vec<FileKey> = files.iter().map(FileKey::from_ref).collect();
            usages.retain(|u| {
                if u.phase != "attach" {
                    return true;
                }
                let key = FileKey {
                    name: u.name.clone(),
                    source: u.source,
                    agent_id: u.agent_id.clone(),
                };
                let file_matches = keys.contains(&key);
                let owner_matches = applied_by.is_none_or(|by| u.applied_by.as_deref() == Some(by));
                // Keep entries that don't match the (file, owner) selection.
                !(file_matches && owner_matches)
            });
            if usages.is_empty() {
                sessions.remove(session_id);
            }
        }
    }

    /// Drop all usage for a session (on session destroy / gone).
    pub fn clear_session(&self, session_id: &str) {
        let mut sessions = self
            .sessions
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        sessions.remove(session_id);
    }

    /// Return the active env files for a session (for visibility).
    #[must_use]
    pub fn active_for(&self, session_id: &str) -> Vec<ActiveEnvFile> {
        let sessions = self
            .sessions
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        sessions
            .get(session_id)
            .map(|u| u.iter().map(Usage::to_active).collect())
            .unwrap_or_default()
    }

    /// Return the session ids currently using the given file.
    #[must_use]
    pub fn sessions_using(
        &self,
        name: &str,
        source: EnvSource,
        agent_id: Option<&str>,
    ) -> Vec<String> {
        let key = FileKey {
            name: name.to_string(),
            source,
            agent_id: agent_id.map(str::to_string),
        };
        let sessions = self
            .sessions
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut result: Vec<String> = sessions
            .iter()
            .filter(|(_, usages)| usages.iter().any(|u| u.matches(&key)))
            .map(|(sid, _)| sid.clone())
            .collect();
        result.sort();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_ref(name: &str) -> EnvFileRef {
        EnvFileRef {
            name: name.to_string(),
            source: EnvSource::Server,
            agent_id: None,
        }
    }

    #[test]
    fn create_then_lock_visible() {
        let reg = EnvUsageRegistry::new();
        reg.record_create("agent:s1", &[file_ref("a.env")], Some("alice"));
        assert_eq!(
            reg.sessions_using("a.env", EnvSource::Server, None),
            vec!["agent:s1".to_string()]
        );
        let active = reg.active_for("agent:s1");
        assert_eq!(active.len(), 1);
        assert_eq!(active.first().unwrap().phase, "create");
        assert_eq!(active.first().unwrap().applied_by.as_deref(), Some("alice"));
    }

    #[test]
    fn clear_session_releases_lock() {
        let reg = EnvUsageRegistry::new();
        reg.record_create("agent:s1", &[file_ref("a.env")], None);
        reg.clear_session("agent:s1");
        assert!(reg
            .sessions_using("a.env", EnvSource::Server, None)
            .is_empty());
    }

    #[test]
    fn remove_attach_scoped_to_owner() {
        let reg = EnvUsageRegistry::new();
        reg.record_attach("agent:s1", &[file_ref("a.env")], Some("alice"));
        reg.record_attach("agent:s1", &[file_ref("b.env")], Some("bob"));
        // Bob detaching removes only his file.
        reg.remove_attach("agent:s1", &[file_ref("b.env")], Some("bob"));
        let names: Vec<String> = reg
            .active_for("agent:s1")
            .into_iter()
            .map(|a| a.name)
            .collect();
        assert_eq!(names, vec!["a.env".to_string()]);
    }

    #[test]
    fn remove_attach_does_not_touch_create() {
        let reg = EnvUsageRegistry::new();
        reg.record_create("agent:s1", &[file_ref("a.env")], None);
        reg.remove_attach("agent:s1", &[file_ref("a.env")], None);
        // create-phase usage survives an attach removal
        assert_eq!(reg.active_for("agent:s1").len(), 1);
    }

    #[test]
    fn record_attach_is_idempotent() {
        let reg = EnvUsageRegistry::new();
        let f = file_ref("a.env");
        // Same file attached twice should only produce one record.
        reg.record_attach("agent:s1", &[f.clone()], Some("alice"));
        reg.record_attach("agent:s1", &[f], Some("alice"));
        assert_eq!(reg.active_for("agent:s1").len(), 1);
    }

    #[test]
    fn multiple_sessions_using_same_file() {
        let reg = EnvUsageRegistry::new();
        reg.record_create("agent:s1", &[file_ref("shared.env")], None);
        reg.record_attach("agent:s2", &[file_ref("shared.env")], None);
        assert_eq!(
            reg.sessions_using("shared.env", EnvSource::Server, None),
            vec!["agent:s1".to_string(), "agent:s2".to_string()]
        );
    }
}
