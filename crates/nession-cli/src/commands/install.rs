//! `nession install <version>` — archive-or-replace release installation.

use crate::update::install::{self, InstallRequest};
use anyhow::Result;

pub async fn run(version: String, dry_run: bool, yes: bool) -> Result<()> {
    install::run(InstallRequest {
        version: Some(version),
        dry_run,
        assume_yes: yes,
        // An explicit install is already the confirmation.
        prompt: false,
        include_installer: false,
    })
    .await
}
