//! `nession profile list` — offline, masked inspection of stored profiles.

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
    if file.profiles.is_empty() {
        println!("No client profiles stored.");
        return Ok(());
    }
    println!();
    println!("Profiles:");
    println!(
        "{:<2}{:<16}{:<48}{:<24}",
        "", "NAME", "SERVER URL", "CREDENTIAL"
    );
    for (name, entry) in &file.profiles {
        let marker = if file.current_profile.as_deref() == Some(name) {
            "* "
        } else {
            "  "
        };
        println!(
            "{marker}{:<16}{:<48}{:<24}",
            name,
            entry.server_url,
            entry.credential_display()
        );
    }
    println!();
    match &file.current_profile {
        Some(current) => println!("Current profile: {current}"),
        None => println!("No profile selected. Select one: nession profile use <name>."),
    }
    Ok(())
}
