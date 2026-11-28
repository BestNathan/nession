//! `nession profile credential set <name> [--stdin]` — store/rotate the
//! endpoint-bound credential through prompt or stdin only.

use anyhow::Result;

use crate::profile::{credential, store, CredentialBackendKind};

pub async fn run(name: &str, stdin: bool) -> Result<()> {
    let loc = super::super::location()?;
    super::super::ensure_writable(&loc)?;

    // The profile must exist before any secret is read.
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
    let endpoint = entry.server_url.clone();
    let rotating = entry.credential_ref.is_some();

    let token = credential::read_secret(name, stdin).await?;
    let record = credential::CredentialRecord::new(&endpoint, &token);
    let choice = credential::BackendChoice::from_env()?;
    let kind = credential::set_bound(&loc, name, &record, choice).await?;

    store::mutate(&loc, |file| {
        let entry = file.profiles.get_mut(name).ok_or_else(|| {
            anyhow::anyhow!("profile {name:?} disappeared while setting its credential")
        })?;
        entry.credential_ref = Some(name.to_string());
        entry.credential_backend = Some(kind);
        entry.no_auth = false;
        Ok(())
    })?;

    if choice == credential::BackendChoice::Auto && kind == CredentialBackendKind::File {
        eprintln!(
            "note: no OS credential store is available; using the private file fallback (0600) \
             under the installation home."
        );
    }
    let verb = if rotating { "Rotated" } else { "Stored" };
    println!(
        "{verb} the credential for profile '{name}' (bound to {}; backend: {}).",
        crate::profile::canonical_endpoint(&endpoint),
        kind.label()
    );
    Ok(())
}
