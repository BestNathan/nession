//! `nession install <version>` — archive-or-replace release installation.

use crate::update::install::{self, InstallRequest, LocalArtifact};
use crate::update::policy::PolicyOverrides;
use anyhow::Result;
use std::path::PathBuf;

#[allow(clippy::too_many_arguments)]
pub async fn run(
    version: String,
    dry_run: bool,
    yes: bool,
    local_artifact: Option<String>,
    artifact_sha256: Option<String>,
    policy_overrides: PolicyOverrides,
) -> Result<()> {
    let local_artifact = match (local_artifact, artifact_sha256) {
        (Some(path), Some(sha256)) => Some(LocalArtifact {
            path: PathBuf::from(path),
            sha256,
        }),
        _ => None,
    };
    install::run(InstallRequest {
        version: Some(version),
        dry_run,
        assume_yes: yes,
        // An explicit install is already the confirmation.
        prompt: false,
        include_installer: false,
        policy_overrides,
        local_artifact,
    })
    .await
}
