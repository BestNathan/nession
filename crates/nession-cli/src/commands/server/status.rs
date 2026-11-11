//! `nession server status` — report only verified running-process facts.
//!
//! The config line is the file the running process recorded in its identity.
//! A default config file is never read here: it is not evidence about a
//! process that may have been started with `--config`.

use crate::lifecycle::{pid_file, process};
use anyhow::Result;

pub async fn run(pid_file_path: Option<String>) -> Result<()> {
    let state = pid_file::StateFiles::from_cli(pid_file_path, pid_file::Component::Server)?;

    // Ownership, like `stop` (#1016): reading a bare pid out of an identity
    // file would report a serving server as stopped. A live pre-runtime daemon
    // is still discoverable through the legacy location.
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
            pid_file::report_not_live_status(record, "Server");
        } else {
            println!("Status: stopped (no state file)");
        }
        for warning in inspection.unresolved_warnings("server") {
            eprintln!("Warning: {warning}");
        }
        return Ok(());
    };

    let uptime = process::get_process_uptime(identity.pid).map(pid_file::format_duration);

    println!("Status: running");
    println!("PID: {}", identity.pid);
    println!(
        "Release: {}",
        identity.release_version.as_deref().unwrap_or("unknown")
    );
    if record.origin == pid_file::Origin::Legacy {
        println!(
            "State file: {} (legacy location; run `nession server restart` to migrate)",
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

    Ok(())
}
