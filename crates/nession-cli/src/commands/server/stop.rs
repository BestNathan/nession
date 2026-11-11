//! `nession server stop` — stop the Server daemon by owned PID identity.

use crate::lifecycle::lock::LifecycleLock;
use crate::lifecycle::{pid_file, terminate};
use anyhow::Result;
use std::fs;

pub async fn run(pid_file_path: Option<String>) -> Result<()> {
    let state = pid_file::StateFiles::from_cli(pid_file_path, pid_file::Component::Server)?;
    let lock = LifecycleLock::acquire()?;
    run_with(state, &lock).await
}

/// Stop from already-resolved state locations, holding the lifecycle lock.
///
/// `restart` uses this entry point so it stops the same locations it will
/// start, including a still-live legacy daemon.
pub(crate) async fn run_with(state: pid_file::StateFiles, _lock: &LifecycleLock) -> Result<()> {
    // Ownership, not liveness (#1016) — the same reading the agent's `stop`
    // makes, and for the same reason: a reused pid is somebody else's process.
    // Both locations are considered so a daemon started by a pre-runtime
    // binary remains manageable; reused or unprovable legacy records are
    // reported and left in place, never signalled.
    let inspection = pid_file::Inspection::of(&state);
    let live = inspection.live_records();
    if live.is_empty() {
        inspection.clean_dead();
        for record in &inspection.records {
            pid_file::report_not_live(record, "Server");
        }
        for warning in inspection.unresolved_warnings("server") {
            eprintln!("Warning: {warning}");
        }
        return Ok(());
    }

    let mut stopped: Vec<u32> = Vec::new();
    for (record, identity) in live {
        if record.origin == pid_file::Origin::Legacy {
            println!(
                "Using legacy state file {}; stop migrates it to {}",
                record.path, state.current
            );
        }
        if !stopped.contains(&identity.pid) {
            // The grace timeout re-verifies the same identity before SIGKILL
            // (#3232 F6); a reused pid is never signalled.
            terminate::stop_verified(&record.path, &identity, pid_file::Component::Server).await?;
            stopped.push(identity.pid);
        }
        // A manager restart (or another writer) can replace the record during
        // the grace period. A live identity that is not the one this stop was
        // for belongs to a new process and must not be erased.
        match pid_file::ownership(&record.path) {
            Ok(pid_file::Ownership::Alive(_)) | Err(_) => {}
            Ok(_) => {
                let _ = fs::remove_file(&record.path);
            }
        }
    }

    Ok(())
}
