//! `nession profile credential clear <name>` — delete the stored credential
//! and return the profile to the unset state.

use anyhow::{bail, Result};

use crate::profile::store;

pub async fn run(name: &str) -> Result<()> {
    let loc = super::super::location()?;
    super::super::ensure_writable(&loc)?;
    let mut deletions = Vec::new();
    store::mutate(&loc, |file| {
        let Some(entry) = file.profiles.get(name) else {
            bail!(
                "unknown profile {name:?}; run `nession profile list` to see the stored profiles"
            );
        };
        if entry.credential_ref.is_none() {
            bail!("profile {name:?} has no stored credential to clear");
        }
        super::super::take_credential_reference(file, name, &mut deletions);
        Ok(())
    })?;
    super::super::apply_deletions(&loc, deletions).await?;

    println!("Deleted the credential for profile '{name}'; the profile is now unset.");
    println!(
        "  Set a new one: nession profile credential set {name} (or mark no-auth: \
         nession profile set {name} --no-auth)."
    );
    Ok(())
}
