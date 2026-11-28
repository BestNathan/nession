//! `nession profile add <name> --server-url <url> [--no-auth]`.
//!
//! The endpoint arrives as the global `--server-url` (the one declaration);
//! no credential is accepted here — `profile credential set` owns secret
//! input. A duplicate name fails without overwrite; `profile set` is the
//! documented replacement operation. The first profile added becomes current;
//! later adds never change an existing selection.

use anyhow::{bail, Result};

use crate::profile::{self, store};

pub fn run(name: String, server_url: Option<String>, no_auth: bool) -> Result<()> {
    let loc = super::location()?;
    super::ensure_writable(&loc)?;
    let Some(url) = server_url else {
        bail!(
            "`nession profile add {name}` requires --server-url <url> (the endpoint to store). \
             Example: nession profile add {name} --server-url ws://127.0.0.1:8080"
        );
    };
    profile::validate_profile_name(&name)?;
    profile::validate_server_url(&url)?;
    let url = url.trim().to_string();

    let selected = store::mutate(&loc, |file| {
        if file.profiles.contains_key(&name) {
            bail!(
                "profile {name:?} already exists; `add` never overwrites. Replace its endpoint \
                 with `nession profile set {name} --server-url <url>`, or remove it first with \
                 `nession profile remove {name}`."
            );
        }
        file.profiles.insert(
            name.clone(),
            profile::ProfileEntry {
                server_url: url.clone(),
                credential_ref: None,
                credential_backend: None,
                no_auth,
            },
        );
        let selects = file.current_profile.is_none();
        if selects {
            file.current_profile = Some(name.clone());
        }
        Ok(selects)
    })?;

    println!("Added profile '{name}' ({url}).");
    if no_auth {
        println!("  credential: no-auth (explicit).");
    } else {
        println!(
            "  credential: unset. Set one: nession profile credential set {name} \
             (or mark no-auth: nession profile set {name} --no-auth)."
        );
    }
    if selected {
        println!("  Selected as the current profile (first profile).");
    }
    Ok(())
}
