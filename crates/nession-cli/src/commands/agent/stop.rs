//! `nession agent stop` — stop the Agent daemon by owned PID identity.

use crate::lifecycle::lock::LifecycleLock;
use crate::lifecycle::{pid_file, terminate};
use anyhow::Result;
use std::fs;

pub async fn run(pid_file_path: Option<String>) -> Result<()> {
    let state = pid_file::StateFiles::from_cli(pid_file_path, pid_file::Component::Agent)?;
    // The manager's `Restart=on-failure`/`KeepAlive` would race a direct stop
    // and could bring the process back beside the CLI (#3232 F5).
    crate::service::guard_agent_lifecycle(crate::service::AgentLifecycleAction::Stop, &state)?;
    let lock = LifecycleLock::acquire()?;
    run_with(state, &lock).await
}

/// Stop from already-resolved state locations, holding the lifecycle lock.
///
/// `restart` uses this entry point so it stops the same locations it will
/// start, including a still-live legacy daemon.
pub(crate) async fn run_with(state: pid_file::StateFiles, _lock: &LifecycleLock) -> Result<()> {
    // Ownership, not liveness (#1016). "A process with this number exists" and
    // "the agent this file was written for is running" are different claims —
    // pids are reused — and a `stop` acting on the weaker one can signal an
    // unrelated process. Only `Alive` is signalled.
    //
    // Both locations are considered so a daemon started by a pre-runtime
    // binary remains manageable. Records that are stale, reused or unprovable
    // never cause a signal; the legacy ones are reported and left in place.
    let inspection = pid_file::Inspection::of(&state);
    let live = inspection.live_records();
    if live.is_empty() {
        inspection.clean_dead();
        for record in &inspection.records {
            pid_file::report_not_live(record, "Agent");
        }
        for warning in inspection.unresolved_warnings("agent") {
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
            terminate::stop_verified(&record.path, &identity, pid_file::Component::Agent).await?;
            stopped.push(identity.pid);
        }
        let _ = fs::remove_file(&record.path);
    }

    Ok(())
}
