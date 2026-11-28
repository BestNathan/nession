//! `nession profile …` leaf handlers (#4682).
//!
//! One file per leaf. Storage rules live in [`crate::profile::store`];
//! credential bytes in [`crate::profile::credential`]; target/credential
//! resolution in [`crate::connection`]. These handlers only translate parsed
//! arguments into one owner call and print masked, secret-free results.

pub mod add;
pub mod credential;
pub mod current;
pub mod import_agent;
pub mod list;
pub mod remove;
pub mod set;
pub mod show;
pub mod test;
pub mod use_profile;

use anyhow::{bail, Result};

use crate::profile::credential as credential_store;
use crate::profile::store::{self, StoreLocation};
use crate::profile::{ClientConfigFile, CredentialBackendKind};

/// The installation client store for a management command. A dispatched
/// archive without a handed-over installation home has nothing to manage.
pub fn location() -> Result<StoreLocation> {
    store::StoreLocation::locate()?.ok_or_else(|| {
        anyhow::anyhow!(
            "no client connection store is available to this release; run profile management \
             on Current (without a version selector)."
        )
    })
}

/// Refuse a mutation before any side effect (prompt, secret write) happens.
pub fn ensure_writable(loc: &StoreLocation) -> Result<()> {
    if loc.read_only {
        bail!(
            "this archived release consumes the installation's client connection context \
             read-only; client profile management runs on Current. Run the command without a \
             version selector (no +<version> / NESSION_VERSION)."
        );
    }
    Ok(())
}

/// Owned credential bytes to delete after a metadata commit.
pub struct CredentialDeletion {
    pub profile: String,
    pub kind: CredentialBackendKind,
}

/// Clear a profile's credential reference inside a store mutation, recording
/// the bytes to delete afterwards. Only owned, unreferenced credentials are
/// recorded: a reference another profile still names is never deleted.
pub fn take_credential_reference(
    file: &mut ClientConfigFile,
    name: &str,
    deletions: &mut Vec<CredentialDeletion>,
) {
    let referenced_elsewhere = file
        .profiles
        .iter()
        .any(|(other, entry)| other != name && entry.credential_ref.as_deref() == Some(name));
    if let Some(entry) = file.profiles.get_mut(name) {
        if let Some(kind) = entry.credential_backend.take() {
            entry.credential_ref = None;
            if !referenced_elsewhere {
                deletions.push(CredentialDeletion {
                    profile: name.to_string(),
                    kind,
                });
            }
        }
    }
}

/// Delete the recorded credential bytes after the metadata commit. A failure
/// is surfaced (the metadata change stands; the bytes are unreferenced).
pub async fn apply_deletions(
    loc: &StoreLocation,
    deletions: Vec<CredentialDeletion>,
) -> Result<()> {
    for deletion in deletions {
        credential_store::delete_bound(loc, &deletion.profile, deletion.kind)
            .await
            .map_err(|error| {
                error.context(format!(
                    "the profile metadata was updated, but deleting the stored credential for \
                     {:?} failed; it is now unreferenced. Restore backend access and re-run the \
                     operation, or delete it explicitly.",
                    deletion.profile
                ))
            })?;
    }
    Ok(())
}
