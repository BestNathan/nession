//! `nession version inspect <version>` — read-only archive diagnostics.
//!
//! Distinguishes the three facts #4592 §5 asks for: binary availability,
//! snapshot coverage, and safe historical runtime eligibility. Also prints the
//! non-secret recovery plan (entry names and statuses only, never contents).
//! This command never mutates anything; re-running it is always safe.

use super::{entry_status, RECOVERABLE_ENTRIES};
use crate::versions::{self, StateCoverage};
use anyhow::{Context, Result};

pub fn run(version: String) -> Result<()> {
    let version = versions::normalize_version(&version)?;
    let home = versions::version_home(&version)?;
    println!("Release {version} ({})", home.display());

    // 1. Binary availability.
    if !home.exists() {
        println!("Binaries: not installed");
        println!("Historical runtime: unavailable (install the release first)");
        return Ok(());
    }
    if versions::is_complete_archive(&home) {
        println!("Binaries: complete (nession, nession-agent, nession-server)");
    } else {
        println!("Binaries: INCOMPLETE (a release executable is missing)");
    }

    // 2. Snapshot coverage.
    match versions::archive_state_coverage(&home) {
        StateCoverage::Proven => {
            println!(
                "State coverage: proven (complete independent snapshot, no external dependencies)"
            );
        }
        StateCoverage::Unproven { reason } => {
            println!("State coverage: UNPROVEN — {reason}");
        }
        StateCoverage::NoManifest => {
            println!("State coverage: unknown (no manifest.json; legacy or binary-only archive)");
        }
    }
    if let Some(manifest) = crate::update::snapshot::read_manifest(&home) {
        println!(
            "Manifest: schema {}, created by {}",
            manifest.schema, manifest.created_by
        );
        println!("  state-complete: {}", manifest.state_complete);
        for gap in &manifest.gaps {
            println!("  gap: {gap}");
        }
        for dependency in &manifest.external_dependencies {
            println!("  external dependency: {dependency}");
        }
        for reference in &manifest.references {
            println!(
                "  referenced store: {} ({} entries, {} bytes, not copied)",
                reference.relative, reference.entries, reference.bytes
            );
        }
    }

    // 3. Safe historical runtime eligibility.
    let eligible = versions::is_complete_archive(&home)
        && versions::archive_state_coverage(&home) == StateCoverage::Proven;
    if eligible {
        println!("Historical runtime: eligible for data-touching commands via +{version}");
    } else {
        println!(
            "Historical runtime: BLOCKED for data-touching commands; read-only inspection \
             (status/logs/list/show) remains available"
        );
    }

    // 4. Recovery plan against Current (names and statuses only).
    let current_home = nession_common::paths::nession_home()
        .context("cannot resolve the Current Nession home for the recovery plan")?;
    println!("Recovery plan (source: this archive, destination: Current):");
    for relative in RECOVERABLE_ENTRIES {
        let status = entry_status(&current_home, &home, relative)?;
        println!("  {relative}: {}", status.label());
    }
    println!(
        "Note: business data (Server DB, sessions, workspaces) is not auto-recovered; use the \
         owner's backup/restore path with explicit reconciliation."
    );
    Ok(())
}
