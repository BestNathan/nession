//! `nession version …` — one module per leaf command.
//!
//! `list` is the release inventory; `inspect` is read-only archive diagnostics
//! (binary availability, snapshot coverage, historical runtime eligibility and
//! a recovery plan); `recover` copies missing configuration/identity from a
//! selected archive back into Current, refusing any conflict (#4592 §5/§6).

pub mod inspect;
pub mod list;
pub mod recover;

use anyhow::{bail, Result};
use std::path::Path;

/// The retained entries an affected installation may need recovered.
///
/// Deliberately narrow: configuration and identity only. Business data (the
/// Server DB, sessions, workspaces) is owner-specific and must be reconciled
/// through its own backup/restore path — never a blanket copy over a live home.
pub const RECOVERABLE_ENTRIES: [&str; 3] =
    ["agent-config.toml", "server-config.toml", "agent/identity"];

/// The recovery plan for one entry, comparing Current with the source archive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryStatus {
    /// Missing at Current, present in the archive: safe to copy.
    Recoverable,
    /// Present at Current with identical bytes: nothing to do (idempotent).
    AlreadyPresent,
    /// Present at Current with different bytes: refuse, never overwrite.
    Conflict,
    /// Present at Current only; the archive holds no copy.
    CurrentOnly,
    /// Missing in both places: nothing to recover.
    Absent,
}

impl EntryStatus {
    pub fn label(self) -> &'static str {
        match self {
            EntryStatus::Recoverable => "recoverable (missing at Current)",
            EntryStatus::AlreadyPresent => "already present (identical)",
            EntryStatus::Conflict => "CONFLICT (Current differs; preserved)",
            EntryStatus::CurrentOnly => "Current only (archive has no copy)",
            EntryStatus::Absent => "absent in both",
        }
    }
}

/// Compare one entry between Current and the archive (read-only).
pub fn entry_status(
    current_home: &Path,
    archive_home: &Path,
    relative: &str,
) -> Result<EntryStatus> {
    let current = std::fs::read(current_home.join(relative)).ok();
    let archive = std::fs::read(archive_home.join(relative)).ok();
    Ok(match (current, archive) {
        (None, None) => EntryStatus::Absent,
        (None, Some(_)) => EntryStatus::Recoverable,
        (Some(_), None) => EntryStatus::CurrentOnly,
        (Some(current), Some(archive)) => {
            if current == archive {
                EntryStatus::AlreadyPresent
            } else {
                EntryStatus::Conflict
            }
        }
    })
}

/// The whole-run recovery decision derived from the entry plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryDecision {
    /// At least one conflict: preserve Current and copy nothing.
    RefuseConflict,
    /// Nothing is missing; a re-run is a no-op.
    NothingToRecover,
    /// The entries safe to copy, in plan order.
    Copy(Vec<String>),
}

/// One conflict refuses the entire run — never a partial auto-merge.
pub fn recovery_decision(plan: &[(String, EntryStatus)]) -> RecoveryDecision {
    if plan
        .iter()
        .any(|(_, status)| *status == EntryStatus::Conflict)
    {
        return RecoveryDecision::RefuseConflict;
    }
    let copy: Vec<String> = plan
        .iter()
        .filter(|(_, status)| *status == EntryStatus::Recoverable)
        .map(|(relative, _)| relative.clone())
        .collect();
    if copy.is_empty() {
        RecoveryDecision::NothingToRecover
    } else {
        RecoveryDecision::Copy(copy)
    }
}

/// Validate a source entry's provenance before it may be copied (#4592 §6).
///
/// Configs must losslessly parse as TOML (the target schema's full validation
/// is the config owner's job at startup); the identity must be a non-empty
/// single line. A malformed source is refused, never copied into Current.
pub fn validate_provenance(relative: &str, bytes: &[u8]) -> Result<()> {
    if relative.ends_with(".toml") {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| anyhow::anyhow!("{relative} is not valid UTF-8"))?;
        toml::from_str::<toml::Value>(text)
            .map_err(|_| anyhow::anyhow!("{relative} is not valid TOML; refusing to recover it"))?;
    } else if relative == "agent/identity" {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| anyhow::anyhow!("agent/identity is not valid UTF-8"))?;
        if text.trim().is_empty() {
            bail!("agent/identity is empty; refusing to recover a blank identity");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(root: &Path, relative: &str, body: &str) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn entry_status_distinguishes_missing_identical_and_conflicting() {
        let current = TempDir::new().unwrap();
        let archive = TempDir::new().unwrap();
        write(archive.path(), "agent-config.toml", "a = 1\n");
        assert_eq!(
            entry_status(current.path(), archive.path(), "agent-config.toml").unwrap(),
            EntryStatus::Recoverable
        );
        write(current.path(), "agent-config.toml", "a = 1\n");
        assert_eq!(
            entry_status(current.path(), archive.path(), "agent-config.toml").unwrap(),
            EntryStatus::AlreadyPresent
        );
        write(current.path(), "agent-config.toml", "a = 2\n");
        assert_eq!(
            entry_status(current.path(), archive.path(), "agent-config.toml").unwrap(),
            EntryStatus::Conflict
        );
        assert_eq!(
            entry_status(current.path(), archive.path(), "agent/identity").unwrap(),
            EntryStatus::Absent
        );
    }

    #[test]
    fn provenance_refuses_malformed_sources() {
        assert!(validate_provenance("agent-config.toml", b"not = [toml").is_err());
        assert!(validate_provenance("agent-config.toml", b"a = 1\n").is_ok());
        assert!(validate_provenance("agent/identity", b"  ").is_err());
        assert!(validate_provenance("agent/identity", b"agent-123\n").is_ok());
    }

    #[test]
    fn one_conflict_refuses_the_whole_run() {
        let plan = vec![
            ("agent-config.toml".to_string(), EntryStatus::Conflict),
            ("server-config.toml".to_string(), EntryStatus::Recoverable),
        ];
        assert_eq!(recovery_decision(&plan), RecoveryDecision::RefuseConflict);
    }

    #[test]
    fn missing_entries_are_copied_and_identical_runs_are_no_ops() {
        let plan = vec![
            ("agent-config.toml".to_string(), EntryStatus::AlreadyPresent),
            ("server-config.toml".to_string(), EntryStatus::Recoverable),
            ("agent/identity".to_string(), EntryStatus::Absent),
        ];
        assert_eq!(
            recovery_decision(&plan),
            RecoveryDecision::Copy(vec!["server-config.toml".to_string()])
        );
        let settled = vec![
            ("agent-config.toml".to_string(), EntryStatus::AlreadyPresent),
            ("agent/identity".to_string(), EntryStatus::CurrentOnly),
        ];
        assert_eq!(
            recovery_decision(&settled),
            RecoveryDecision::NothingToRecover
        );
    }
}
