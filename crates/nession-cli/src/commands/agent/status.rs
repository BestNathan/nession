//! `nession agent status` — report only verified running-process facts.
//!
//! The config line comes from the identity the running process wrote. This
//! command must never read the default config file and present its values as
//! live state: the process may have been started with `--config` or a
//! different `NESSION_HOME`, and a default file is not evidence about it.

use crate::lifecycle::{pid_file, process};
use anyhow::Result;

pub async fn run(pid_file_path: Option<String>) -> Result<()> {
    let state = pid_file::StateFiles::from_cli(pid_file_path, pid_file::Component::Agent)?;

    // Ownership, like `stop` (#1016). Reporting "running" for a reused pid
    // would send an operator to look at a process that is not theirs. A live
    // pre-runtime daemon is still discoverable through the legacy location.
    let inspection = pid_file::Inspection::of(&state);
    let Some((record, identity)) = inspection.live() else {
        inspection.clean_dead();
        // One status line: the first record that says anything (runtime
        // first), not one line per location.
        if let Some(record) = inspection
            .records
            .iter()
            .find(|record| !matches!(record.state, pid_file::RecordState::Missing))
        {
            pid_file::report_not_live_status(record, "Agent");
        } else {
            println!("Status: stopped (no state file)");
        }
        for warning in inspection.unresolved_warnings("agent") {
            eprintln!("Warning: {warning}");
        }
        return Ok(());
    };

    let uptime = process::get_process_uptime(identity.pid).map(pid_file::format_duration);

    println!("Status: running");
    println!("PID: {}", identity.pid);
    if record.origin == pid_file::Origin::Legacy {
        println!(
            "State file: {} (legacy location; run `nession agent restart` to migrate)",
            record.path
        );
    }
    if let Some(uptime) = uptime {
        println!("Uptime: {uptime}");
    }
    match &identity.config_source {
        pid_file::ConfigRecord::File(path) => {
            println!("Config: {path} (recorded by the running process)")
        }
        pid_file::ConfigRecord::Defaults => {
            println!("Config: built-in defaults (no config file was loaded)")
        }
        pid_file::ConfigRecord::Unknown => {
            println!("Config: unknown (the running process did not record which configuration it loaded)")
        }
    }
    println!("Autostart: {}", crate::service::service_status());

    Ok(())
}
