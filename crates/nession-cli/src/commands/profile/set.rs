//! `nession profile set <name> [--server-url <url>] [--no-auth]`.
//!
//! The documented replacement operation (`add` never overwrites). Changing
//! the canonical endpoint invalidates the bound credential: its owned,
//! unreferenced bytes are deleted and the profile returns to the unset state
//! unless `--no-auth` is given. `--no-auth` alone also deletes the bound
//! credential (it is no longer referenced).

use anyhow::{bail, Result};

use crate::profile::{self, store};

pub async fn run(name: String, server_url: Option<String>, no_auth: bool) -> Result<()> {
    let loc = super::location()?;
    super::ensure_writable(&loc)?;
    if server_url.is_none() && !no_auth {
        bail!(
            "`nession profile set {name}` has nothing to set: pass --server-url <url> and/or \
             --no-auth."
        );
    }
    if let Some(url) = &server_url {
        profile::validate_server_url(url)?;
    }

    let mut deletions = Vec::new();
    let (endpoint_changed, credential_invalidated) = store::mutate(&loc, |file| {
        let Some(entry) = file.profiles.get(&name).cloned() else {
            bail!(
                "unknown profile {name:?}; run `nession profile list` to see the stored profiles"
            );
        };
        let new_url = server_url
            .clone()
            .map(|url| url.trim().to_string())
            .unwrap_or_else(|| entry.server_url.clone());
        let endpoint_changed =
            profile::canonical_endpoint(&new_url) != profile::canonical_endpoint(&entry.server_url);
        let had_credential = entry.credential_ref.is_some();
        if endpoint_changed || no_auth {
            super::take_credential_reference(file, &name, &mut deletions);
        }
        let entry = file
            .profiles
            .get_mut(&name)
            .ok_or_else(|| anyhow::anyhow!("profile {name:?} disappeared while editing it"))?;
        entry.server_url = new_url;
        if no_auth {
            entry.no_auth = true;
        } else if endpoint_changed {
            entry.no_auth = false;
        }
        Ok((
            endpoint_changed,
            had_credential && (endpoint_changed || no_auth),
        ))
    })?;
    super::apply_deletions(&loc, deletions).await?;

    println!("Updated profile '{name}'.");
    if let Some(url) = &server_url {
        if endpoint_changed {
            println!("  endpoint: {url}");
        }
    }
    if credential_invalidated {
        println!(
            "  The previous endpoint-bound credential was invalidated (deleted). Set a new \
             one: nession profile credential set {name}."
        );
    }
    if no_auth {
        println!("  credential: no-auth (explicit).");
    } else if endpoint_changed && !credential_invalidated {
        println!(
            "  credential: unset. Set one: nession profile credential set {name} (or mark \
             no-auth: nession profile set {name} --no-auth)."
        );
    }
    Ok(())
}
