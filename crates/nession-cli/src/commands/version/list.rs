//! `nession version list` — Current, Archived and Running releases.
//!
//! Current is the release in the managed install directory; Archived are the
//! complete release homes under `<NESSION_HOME>/versions`; Running is read from
//! the shared OS runtime identity, so it is the same answer for every installed
//! release (#3155). A selected archived CLI never changes Current.

use crate::lifecycle::pid_file::{self, Component};
use crate::versions;
use anyhow::Result;

pub async fn run() -> Result<()> {
    list()
}

pub fn list() -> Result<()> {
    let layout = versions::Layout::resolve()?;
    println!(
        "Current: {} ({})",
        layout.current,
        layout.install_dir.display()
    );

    let archived = versions::archived_versions()?;
    if archived.is_empty() {
        println!("Archived: (none)");
    } else {
        let names = archived
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        println!("Archived: {names}");
    }

    println!("Running:");
    for component in [Component::Agent, Component::Server] {
        match pid_file::default_live(component) {
            Ok(Some((path, identity))) => println!(
                "  {}: release {} (PID {}, state file {path})",
                component.as_str(),
                identity.release_version.as_deref().unwrap_or("unknown"),
                identity.pid
            ),
            Ok(None) => println!("  {}: not running", component.as_str()),
            Err(error) => println!("  {}: unavailable ({error})", component.as_str()),
        }
    }

    Ok(())
}
