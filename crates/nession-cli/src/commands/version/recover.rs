//! `nession version recover <version>` — bounded operator recovery (#4592 §6).
//!
//! For installations already affected by the superseded move-based upgrade:
//! the old transaction moved configuration/identity into `versions/<old>/` and
//! left Current without them. This command copies the **missing** entries back
//! from an explicitly selected source archive, and nothing else:
//!
//! - provenance is proven first (complete archive, version matches its label,
//!   each source entry parses);
//! - a running Agent/Server refuses the operation (no writes under a live
//!   writer);
//! - any entry that already exists at Current with different bytes is a
//!   conflict: the whole run refuses and copies nothing — never an ambiguous
//!   auto-merge or overwrite;
//! - identical entries are skipped, so re-running is idempotent and never
//!   mutates valid data;
//! - business data (DB, sessions, workspaces) is never touched here.

use super::{
    entry_status, recovery_decision, validate_provenance, RecoveryDecision, RECOVERABLE_ENTRIES,
};
use crate::lifecycle::lock::LifecycleLock;
use crate::lifecycle::pid_file::{self, Component};
use crate::versions;
use anyhow::{bail, Context, Result};
use std::path::Path;

pub fn run(version: String) -> Result<()> {
    let version = versions::normalize_version(&version)?;
    let archive = versions::version_home(&version)?;
    if !versions::is_complete_archive(&archive) {
        bail!(
            "release {version} is not a complete archive at {}; refusing to recover from an \
             unproven source",
            archive.display()
        );
    }
    // Provenance: the archive's CLI must report the release its directory
    // claims; a mislabeled tree is not a trusted recovery source.
    let reported = versions::current_version(&archive.join("bin"))
        .with_context(|| format!("cannot prove the provenance of {}", archive.display()))?;
    if reported != version {
        bail!(
            "the archive at {} reports release {reported} but is installed as {version}; \
             refusing to recover from a mislabeled source",
            archive.display()
        );
    }

    let current_home = nession_common::paths::nession_home()?;

    // No recovery under a live writer, and no recovery beside another
    // lifecycle command. Both refusals leave everything untouched.
    for component in [Component::Agent, Component::Server] {
        if let Some((path, identity)) = pid_file::default_live(component)? {
            bail!(
                "{} is running (PID {}, state file {path}); recovery refuses to write \
                 configuration/identity under a live component. Stop it first, then re-run.",
                component.as_str(),
                identity.pid
            );
        }
    }
    let Some(_lock) = LifecycleLock::try_acquire()? else {
        bail!(
            "another lifecycle command holds the lock; recovery refuses to race it. \
             Retry once it finishes."
        );
    };

    // Build the full plan before any write: one conflict refuses the whole run.
    let mut plan = Vec::new();
    for relative in RECOVERABLE_ENTRIES {
        let status = entry_status(&current_home, &archive, relative)?;
        println!("  {relative}: {}", status.label());
        plan.push((relative.to_string(), status));
    }
    let recoverable = match recovery_decision(&plan) {
        RecoveryDecision::RefuseConflict => bail!(
            "Current already holds different configuration/identity; recovery preserves it and \
             refuses an ambiguous merge. Nothing was copied. Reconcile the conflicting entries \
             manually (compare with `nession version inspect {version}`), then re-run."
        ),
        RecoveryDecision::NothingToRecover => {
            println!(
                "Nothing to recover: Current already holds every entry this archive can provide."
            );
            return Ok(());
        }
        RecoveryDecision::Copy(entries) => entries,
    };

    for relative in recoverable {
        let source = archive.join(&relative);
        let bytes = std::fs::read(&source)
            .with_context(|| format!("failed to read the source {}", source.display()))?;
        validate_provenance(&relative, &bytes)
            .with_context(|| format!("the source entry {relative} failed provenance validation"))?;
        let destination = current_home.join(&relative);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        // The entry was proven missing above; refuse a race that created it
        // since the plan rather than overwriting it.
        if destination.exists() {
            bail!(
                "{} appeared while recovery was running; refusing to overwrite it. \
                 Re-run to re-plan.",
                destination.display()
            );
        }
        write_private(&destination, &bytes)?;
        println!("Recovered {relative} from release {version}.");
    }
    println!(
        "Note: business data (Server DB, sessions, workspaces) was not touched; recover it \
         through its owner's backup/restore path with explicit reconciliation."
    );
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("failed to create {}", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("failed to write {}", path.display()))?;
    file.sync_all()
        .with_context(|| format!("failed to sync {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn write_private_creates_owner_only_files_and_refuses_overwrite() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("identity");
        write_private(&path, b"agent-123").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"agent-123");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        assert!(
            write_private(&path, b"other").is_err(),
            "create_new must refuse to overwrite an existing entry"
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"agent-123");
    }
}
