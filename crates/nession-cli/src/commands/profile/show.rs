//! `nession profile show <name>` — offline, masked inspection of one profile.

use anyhow::Result;

use crate::profile::store;

pub fn run(name: &str) -> Result<()> {
    let loc = super::location()?;
    let file = store::load(&loc)?.ok_or_else(|| {
        anyhow::anyhow!(
            "unknown profile {name:?}: no client connection store at {}",
            loc.config_path().display()
        )
    })?;
    let entry = file.profiles.get(name).ok_or_else(|| {
        anyhow::anyhow!(
            "unknown profile {name:?}; run `nession profile list` to see the stored profiles"
        )
    })?;
    println!("Profile: {name}");
    println!("  endpoint: {}", entry.server_url);
    println!("  credential: {}", entry.credential_display());
    let selected = file.current_profile.as_deref() == Some(name);
    println!(
        "  selected: {}",
        if selected { "yes (current)" } else { "no" }
    );
    Ok(())
}
