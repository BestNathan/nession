//! `nession server status` — report only verified running-process facts.
//!
//! The config line is the file the running process recorded in its identity.
//! A default config file is never read here: it is not evidence about a
//! process that may have been started with `--config`.

use crate::lifecycle::{pid_file, process};
use anyhow::Result;

pub async fn run(pid_file_path: Option<String>) -> Result<()> {
    let pid_file = pid_file::resolve_path(pid_file_path, pid_file::Component::Server);

    let identity = match pid_file::ownership(&pid_file) {
        Ok(pid_file::Ownership::Alive(identity)) => identity,
        Ok(pid_file::Ownership::Reused(identity)) => {
            println!(
                "Status: stopped (pid {} is running but is not this server)",
                identity.pid
            );
            let _ = std::fs::remove_file(&pid_file);
            return Ok(());
        }
        Ok(pid_file::Ownership::Stale(_)) => {
            println!("Status: stopped (process not running)");
            let _ = std::fs::remove_file(&pid_file);
            return Ok(());
        }
        Err(_) => {
            println!("Status: stopped (no state file)");
            return Ok(());
        }
    };

    let uptime = process::get_process_uptime(identity.pid).map(pid_file::format_duration);

    println!("Status: running");
    println!("PID: {}", identity.pid);
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
