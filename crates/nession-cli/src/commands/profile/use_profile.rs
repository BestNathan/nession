//! `nession profile use <name>` — change the client selection only.

use anyhow::{bail, Result};

use crate::profile::store;

pub fn run(name: &str) -> Result<()> {
    let loc = super::location()?;
    super::ensure_writable(&loc)?;
    store::mutate(&loc, |file| {
        if !file.profiles.contains_key(name) {
            bail!(
                "unknown profile {name:?}; run `nession profile list` to see the stored profiles"
            );
        }
        file.current_profile = Some(name.to_string());
        Ok(())
    })?;
    println!("Selected profile '{name}' as current.");
    Ok(())
}
