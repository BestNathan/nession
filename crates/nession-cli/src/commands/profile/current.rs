//! `nession profile current` — offline inspection of the persisted selection.

use anyhow::Result;

use crate::profile::store;

pub fn run() -> Result<()> {
    let loc = super::location()?;
    let Some(file) = store::load(&loc)? else {
        println!(
            "No client profiles stored. Add one: nession profile add home --server-url <url> \
             (or import the Agent endpoint: nession profile import-agent)."
        );
        return Ok(());
    };
    let Some(current) = &file.current_profile else {
        println!(
            "No profile selected. Select one: nession profile use <name> \
             (see nession profile list)."
        );
        return Ok(());
    };
    let entry = file
        .profiles
        .get(current)
        .ok_or_else(|| anyhow::anyhow!("current profile {current:?} is missing from the store"))?;
    println!("Current profile: {current}");
    println!("  endpoint: {}", entry.server_url);
    println!("  credential: {}", entry.credential_display());
    println!(
        "  source: persisted selection in {}",
        loc.config_path().display()
    );
    Ok(())
}
