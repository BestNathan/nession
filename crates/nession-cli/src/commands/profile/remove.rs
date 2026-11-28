//! `nession profile remove <name> [--force]`.
//!
//! Removing the current profile requires `--force` and clears the selection;
//! it never silently selects another remote target. The profile's owned,
//! unreferenced credential bytes are deleted with it.

use anyhow::{bail, Result};

use crate::profile::store;

pub async fn run(name: &str, force: bool) -> Result<()> {
    let loc = super::location()?;
    super::ensure_writable(&loc)?;
    let mut deletions = Vec::new();
    let was_current = store::mutate(&loc, |file| {
        if !file.profiles.contains_key(name) {
            bail!(
                "unknown profile {name:?}; run `nession profile list` to see the stored profiles"
            );
        }
        let was_current = file.current_profile.as_deref() == Some(name);
        if was_current && !force {
            bail!(
                "refusing to remove the current profile {name:?} without --force. Removing it \
                 clears the selection; no other target is selected automatically. Pass --force \
                 to confirm."
            );
        }
        super::take_credential_reference(file, name, &mut deletions);
        file.profiles.remove(name);
        if was_current {
            file.current_profile = None;
        }
        Ok(was_current)
    })?;
    super::apply_deletions(&loc, deletions).await?;

    println!("Removed profile '{name}'.");
    if was_current {
        println!(
            "  The current selection was cleared. Select another: nession profile use <name>."
        );
    }
    Ok(())
}
