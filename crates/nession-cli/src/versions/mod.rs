//! Release-version layout and command-level version selection.
//!
//! A Nession installation keeps one **Current** release in the managed install
//! directory and any number of archived releases under
//! `<NESSION_HOME>/versions/<semver>/`. Selection is per command:
//! `nession +<version> …` or `NESSION_VERSION=<version>` runs the archived CLI
//! for that version without changing Current. There is deliberately no
//! `version use` and no working-directory override.
//!
//! The dispatcher here runs before Clap parses anything. It is deliberately
//! small and stable: it resolves the selector, chooses the archive entry and
//! `exec`s it. Every other command stays owned by the selected release.

use anyhow::{bail, Context, Result};
use semver::Version;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Per-command version selector.
pub const NESSION_VERSION_ENV: &str = "NESSION_VERSION";

/// Internal marker for the already-dispatched child. It prevents a selected
/// archived CLI from re-applying the selector and recursing.
pub const NESSION_VERSION_DISPATCHED_ENV: &str = "NESSION_VERSION_DISPATCHED";

/// Internal marker handing a profile-aware archived release the installation
/// home whose client connection context it may consume **read-only** (#4682).
///
/// The dispatcher captures this before rebinding `NESSION_HOME` to the version
/// home, so the archive's daemon state stays isolated while the installation's
/// client selection/credentials remain observable. An archived release never
/// mutates this context and never bootstraps into it.
pub const NESSION_CLIENT_HOME_ENV: &str = "NESSION_CLIENT_HOME";

/// Install directory override. `scripts/install.sh` already honours this name;
/// the CLI uses it for the managed release directory so tests and automated
/// installs never touch the binary that is running them.
pub const NESSION_INSTALL_DIR_ENV: &str = "NESSION_INSTALL_DIR";

const VERSIONS_DIR: &str = "versions";
const BIN_NAME: &str = "nession";

/// Every binary a complete release archive must contain. The archive
/// transaction publishes all three or none; a directory missing one is a
/// half-finished copy, not an installable release (#3232 F4).
pub const RELEASE_BINARIES: [&str; 3] = [BIN_NAME, "nession-agent", "nession-server"];

/// Parse a release version, accepting a standard `v` prefix.
pub fn normalize_version(raw: &str) -> Result<Version> {
    let text = raw.trim();
    let stripped = text.strip_prefix('v').unwrap_or(text);
    Version::parse(stripped).with_context(|| {
        format!("invalid release version '{raw}' (expected SemVer, e.g. 0.35.0 or v0.35.0)")
    })
}

fn this_binary_version() -> Result<Version> {
    Version::parse(env!("CARGO_PKG_VERSION"))
        .context("the CLI's own compiled version is not valid SemVer")
}

/// `<NESSION_HOME>/versions`
pub fn versions_root() -> Result<PathBuf> {
    Ok(nession_common::paths::nession_home()?.join(VERSIONS_DIR))
}

/// `<NESSION_HOME>/versions/<version>`
pub fn version_home(version: &Version) -> Result<PathBuf> {
    versions_root().map(|root| root.join(version.to_string()))
}

/// The archived CLI entry for `version`.
pub fn archived_cli(version: &Version) -> Result<PathBuf> {
    version_home(version).map(|home| home.join("bin").join(BIN_NAME))
}

/// Every archived release with a complete CLI entry, oldest first.
pub fn archived_versions() -> Result<Vec<Version>> {
    let root = versions_root()?;
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut versions = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Ok(version) = Version::parse(&entry.file_name().to_string_lossy()) else {
            continue;
        };
        if is_complete_archive(&entry.path()) {
            versions.push(version);
        }
    }
    versions.sort();
    Ok(versions)
}

/// Whether `dir` is a complete release archive: all three runnable binaries.
pub fn is_complete_archive(dir: &Path) -> bool {
    dir.is_dir()
        && RELEASE_BINARIES
            .iter()
            .all(|name| dir.join("bin").join(name).is_file())
}

/// An archive's proven durable-state coverage (#4592 §5).
///
/// Binary availability, snapshot coverage and safe historical runtime
/// eligibility are three different facts. A complete archive may still be
/// unsafe to run data-touching commands against: a binary-only archive has no
/// state at all, and a manifest with gaps or external dependencies cannot
/// prove the release owns an independent copy of everything it would touch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateCoverage {
    /// The manifest proves a complete independent snapshot with no external
    /// dependencies: data-touching commands may run against this archive.
    Proven,
    /// A manifest exists but records gaps or external dependencies.
    Unproven { reason: String },
    /// No manifest: a legacy or binary-only archive. Its state is unknown.
    NoManifest,
}

/// Classify an archive's whole-state coverage from its manifest (read-only).
///
/// Schema-2 archives are classified from typed coverage; schema-1 archives are
/// classified conservatively from their recorded `state_complete` flag and
/// dependencies — never promoted to proven and never rewritten (#4660).
pub fn archive_state_coverage(home: &Path) -> StateCoverage {
    let Some(manifest) = crate::update::snapshot::read_manifest(home) else {
        return StateCoverage::NoManifest;
    };
    if !manifest.external_dependencies.is_empty() {
        return StateCoverage::Unproven {
            reason: format!(
                "the archived config still depends on paths the archive does not own: {}",
                manifest.external_dependencies.join(", ")
            ),
        };
    }
    if manifest.schema >= 2 && !manifest.coverage.is_empty() {
        let plan = crate::update::snapshot::SnapshotPlan {
            references: manifest.references.clone(),
            ..Default::default()
        };
        if crate::update::snapshot::coverage_state_complete(&manifest.coverage, &plan) {
            return StateCoverage::Proven;
        }
        return StateCoverage::Unproven {
            reason: format!(
                "the snapshot is not state-complete ({})",
                manifest.gaps.join("; ")
            ),
        };
    }
    // Legacy schema 1: trust only an explicit complete flag with no gaps that
    // indicate missing state. Ambiguous legacy state remains blocked.
    if manifest.state_complete {
        StateCoverage::Proven
    } else {
        StateCoverage::Unproven {
            reason: format!(
                "the snapshot is not state-complete ({})",
                manifest.gaps.join("; ")
            ),
        }
    }
}

/// Classify one component's required-state coverage (#4660 Fix Direction 3).
///
/// Agent and Server assess their own required state plus shared dependencies
/// independently: a safe unrelated exclusion (e.g. Server logs on an Agent-only
/// installation) never blocks an otherwise proven component. Read-only
/// inspection is unaffected; this only gates data-touching commands.
pub fn archive_component_coverage(
    home: &Path,
    component: crate::update::snapshot::CoverageComponent,
) -> StateCoverage {
    use crate::update::snapshot::{self, CoverageComponent};
    let Some(manifest) = snapshot::read_manifest(home) else {
        return StateCoverage::NoManifest;
    };
    if !manifest.external_dependencies.is_empty() {
        return StateCoverage::Unproven {
            reason: format!(
                "the archived config still depends on paths the archive does not own: {}",
                manifest.external_dependencies.join(", ")
            ),
        };
    }
    if manifest.schema >= 2 && !manifest.coverage.is_empty() {
        let plan = snapshot::SnapshotPlan {
            references: manifest.references.clone(),
            ..Default::default()
        };
        if snapshot::coverage_component_proven(&manifest.coverage, &plan, component) {
            return StateCoverage::Proven;
        }
        let blockers: Vec<String> = manifest
            .coverage
            .iter()
            .filter(|e| {
                let nonempty = e.class == snapshot::CoverageClass::Referenced
                    && plan.reference_nonempty(&e.path);
                e.blocks(component, nonempty)
            })
            .map(|e| format!("{} ({})", e.path, e.detail))
            .collect();
        let _ = CoverageComponent::Shared;
        return StateCoverage::Unproven {
            reason: format!(
                "required state is not independently proven: {}",
                blockers.join("; ")
            ),
        };
    }
    // Legacy schema 1 cannot be attributed per component; fall back to the
    // conservative whole-archive classification (no promotion).
    archive_state_coverage(home)
}

/// The component whose required state a data-touching command exercises.
fn command_component(args: &[OsString]) -> Option<crate::update::snapshot::CoverageComponent> {
    use crate::update::snapshot::CoverageComponent;
    let tokens = command_tokens(args);
    let family = tokens.first()?.as_str();
    match family {
        "agent" => Some(CoverageComponent::Agent),
        "server" => Some(CoverageComponent::Server),
        // Session metadata is Agent-owned durable state.
        "sessions" => Some(CoverageComponent::Agent),
        "config" => match tokens.get(1).map(String::as_str) {
            Some("server") => Some(CoverageComponent::Server),
            _ => Some(CoverageComponent::Agent),
        },
        _ => None,
    }
}

/// Refuse a data-touching command on an archive whose independent state
/// ownership cannot be proven for the affected component (#4592 §5, #4660).
/// Runs at the Current dispatcher before `exec`, for legacy versions included.
fn verify_archive_state_coverage(
    home: &Path,
    version: &Version,
    command: &str,
    component: crate::update::snapshot::CoverageComponent,
) -> Result<()> {
    match archive_component_coverage(home, component) {
        StateCoverage::Proven => Ok(()),
        StateCoverage::NoManifest => bail!(
            "release {version} is a binary-complete archive without a proven state snapshot \
             (no manifest.json); `{command}` is refused. The archive cannot prove it owns an \
             independent copy of the configuration and identity, and running it could touch \
             Current's live state or mint a new identity.\n\
             Fix: inspect it with `nession version inspect {version}`. If it holds your only \
             copy of the configuration/identity, recover the missing entries with \
             `nession version recover {version}`; otherwise run `{command}` on Current \
             (without a version selector)."
        ),
        StateCoverage::Unproven { reason } => bail!(
            "release {version} has unproven state coverage: {reason}. `{command}` is refused \
             until independent ownership is established.\n\
             Fix: `nession version inspect {version}` shows the coverage record; run the \
             command on Current, or reconcile the recorded gaps and dependencies first."
        ),
    }
}

/// The first three non-flag command tokens, skipping global flags that take a
/// value so a value named like a command cannot masquerade as one.
fn command_tokens(args: &[OsString]) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut index = 1;
    while let Some(value) = args.get(index) {
        let Some(token) = value.to_str() else {
            return tokens;
        };
        if matches!(token, "--server-url" | "--auth-token" | "--profile") {
            index += 2;
            continue;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        tokens.push(token.to_string());
        if tokens.len() == 3 {
            break;
        }
        index += 1;
    }
    tokens
}

/// The data-touching command named by the args, if any (#4592 §5).
///
/// Read-only inspection (`status`, `logs`, `list`, `show`, `agents list`)
/// stays available on every complete archive; everything that writes config,
/// identity, sessions or host service state is gated on proven coverage.
fn mutating_command(args: &[OsString]) -> Option<String> {
    let tokens = command_tokens(args);
    let family = tokens.first()?.as_str();
    let action = tokens.get(1).map(String::as_str).unwrap_or("");
    let mutating = match family {
        "agent" => !matches!(action, "status" | "logs" | ""),
        "server" => !matches!(action, "status" | "logs" | ""),
        "sessions" => !matches!(action, "list" | ""),
        "config" => tokens.get(2).map(String::as_str) != Some("show"),
        _ => false,
    };
    if mutating {
        Some(tokens.join(" "))
    } else {
        None
    }
}

/// The directory whose release binaries own the Current installation.
///
/// `NESSION_INSTALL_DIR` lets the installer and Cases target an isolated tree;
/// otherwise the running CLI's directory is the managed one.
pub fn current_install_dir() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var(NESSION_INSTALL_DIR_ENV) {
        if !dir.trim().is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    Ok(crate::update::replace::cli_install_dir()?)
}

/// The release version of the installed Current CLI.
///
/// When the running binary is that file, its compiled version is authoritative
/// and no child process is spawned. Otherwise the installed `nession --version`
/// is the source of truth: Current is the version in the install directory, not
/// the version of some other binary that happens to be running.
pub fn current_version(install_dir: &Path) -> Result<Version> {
    let candidate = install_dir.join(BIN_NAME);
    let canonical_candidate =
        std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
    let running = std::env::current_exe()
        .ok()
        .and_then(|path| std::fs::canonicalize(path).ok());
    if running.as_deref() == Some(canonical_candidate.as_path()) {
        return this_binary_version();
    }

    let output = Command::new(&candidate)
        .arg("--version")
        .output()
        .with_context(|| {
            format!(
                "cannot run the installed Current CLI at {}; is the installation complete?",
                candidate.display()
            )
        })?;
    if !output.status.success() {
        bail!(
            "the installed Current CLI at {} did not report a version",
            candidate.display()
        );
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let token = stdout
        .split_whitespace()
        .last()
        .context("the installed Current CLI printed no version")?;
    normalize_version(token.trim()).with_context(|| {
        format!(
            "the installed Current CLI at {} reported '{token}', which is not a release version",
            candidate.display()
        )
    })
}

/// The version layout of this installation.
#[derive(Debug, Clone)]
pub struct Layout {
    pub home: PathBuf,
    pub install_dir: PathBuf,
    pub current: Version,
}

impl Layout {
    pub fn resolve() -> Result<Self> {
        let home = nession_common::paths::nession_home()?;
        let install_dir = current_install_dir()?;
        let current = current_version(&install_dir)?;
        Ok(Self {
            home,
            install_dir,
            current,
        })
    }
}

/// Arguments after selector handling.
#[derive(Debug)]
pub struct PreparedArgs {
    pub args: Vec<OsString>,
}

/// Resolve `+<version>` / `NESSION_VERSION` and dispatch to the archived CLI.
///
/// Returns the arguments Clap should parse when the Current CLI handles the
/// command. Selection is per command only; this never mutates Current.
pub fn prepare<I: IntoIterator<Item = OsString>>(raw_args: I) -> Result<PreparedArgs> {
    let mut args: Vec<OsString> = raw_args.into_iter().collect();
    if args.is_empty() {
        args.push(OsString::from(BIN_NAME));
    }

    // A dispatched child runs the selected release; it must not select again.
    if std::env::var_os(NESSION_VERSION_DISPATCHED_ENV).is_some() {
        return Ok(PreparedArgs { args });
    }

    let mut selected: Option<(Version, bool)> = None;
    if let Some(raw) = args.get(1).and_then(|value| value.to_str()) {
        if let Some(version) = raw.strip_prefix('+').filter(|version| !version.is_empty()) {
            selected = Some((normalize_version(version)?, true));
            args.remove(1);
        }
    }
    if selected.is_none() {
        if let Ok(raw) = std::env::var(NESSION_VERSION_ENV) {
            if !raw.trim().is_empty() {
                selected = Some((normalize_version(&raw)?, false));
            }
        }
    }
    let Some((version, explicit)) = selected else {
        return Ok(PreparedArgs { args });
    };

    let current = this_binary_version()?;
    if version == current {
        return Ok(PreparedArgs { args });
    }

    match command_name(&args).as_deref() {
        // The global inventory always runs on Current, even with a selector.
        Some("version") => return Ok(PreparedArgs { args }),
        // These two manage the Current installation; a selector would silently
        // install into an archived home instead.
        Some("install") | Some("update") => bail!(
            "`nession {}` manages the Current installation; run it without {} or {}",
            command_name(&args).unwrap_or_default(),
            if explicit {
                "+<version>"
            } else {
                NESSION_VERSION_ENV
            },
            if explicit {
                NESSION_VERSION_ENV
            } else {
                "+<version>"
            }
        ),
        _ => {}
    }

    let home = version_home(&version)?;
    if !is_complete_archive(&home) {
        let detail = if home.exists() {
            "is incomplete (an executable is missing)"
        } else {
            "is not installed"
        };
        bail!(
            "release {version} {detail} at {}; run `nession install {version}`",
            home.display()
        );
    }
    // A data-touching command must not run against an archive whose
    // independent state ownership is unproven (#4592 §5): a binary-only or
    // legacy archive could touch Current's live state or mint a new identity.
    if let Some(command) = mutating_command(&args) {
        let component =
            command_component(&args).unwrap_or(crate::update::snapshot::CoverageComponent::Shared);
        verify_archive_state_coverage(&home, &version, &command, component)?;
    }
    let cli = archived_cli(&version)?;
    // Read-only logs: the selected release reads its own home. A release that
    // predates the logs command cannot do that itself; the Current CLI reads
    // the archive's directory directly instead of falling back to Current
    // (#4600 SC-04). Nothing here writes or recovers.
    if let Some(family) = logs_family(&args) {
        if !archive_supports_logs(&cli, &home, &family) {
            eprintln!(
                "nession: release {version} predates `{family} logs`; reading its log \
                 directory directly (read-only). The archive is not modified and Current \
                 is not consulted."
            );
            dispatch_logs_read_only(&args, &version, &home)?;
            unreachable!("logs dispatch always execs or exits");
        }
    }
    // A dangerous lifecycle command must not be executed by a release that
    // predates the shared lock/PID/single-active contract: it would look in
    // its own home and could start a second daemon (#3232 F2).
    if let Some((family, action)) = lifecycle_command(&args) {
        verify_archived_lifecycle_contract(&cli, &version, &home, &family, &action)?;
    }
    // Client connection profiles (#4682): the installation's client context
    // is distinct from the archive's daemon state. A profile-aware archive
    // consumes it read-only through NESSION_CLIENT_HOME (captured here, before
    // NESSION_HOME is rebound to the version home); an archive without support
    // keeps legacy explicit URL/env behavior but must never silently
    // reinterpret a profile-dependent invocation as localhost.
    let mut client_home: Option<PathBuf> = None;
    if let Some(family) = client_profile_family(&args) {
        if archive_supports_client_profiles(&cli, &home) {
            client_home = Some(nession_common::paths::nession_home()?);
        } else {
            verify_unsupported_archive_client_context(&args, &version, &family)?;
        }
    }
    let mut command = Command::new(&cli);
    command
        .args(args.get(1..).unwrap_or(&[]))
        .env(nession_common::paths::NESSION_HOME_ENV, home)
        .env_remove(NESSION_VERSION_ENV)
        .env(NESSION_VERSION_DISPATCHED_ENV, "1")
        .env("NESSION_NO_UPDATE_CHECK", "1");
    if let Some(client_home) = client_home {
        command.env(NESSION_CLIENT_HOME_ENV, client_home);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        Err(anyhow::Error::new(error).context(format!(
            "failed to run the archived CLI at {}",
            cli.display()
        )))
    }
    #[cfg(not(unix))]
    {
        let status = command
            .status()
            .with_context(|| format!("failed to run the archived CLI at {}", cli.display()))?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

/// Whether the CLI must skip its background update check for `args`.
///
/// `logs` is local, read-only diagnostics; it never performs a network update
/// check (#4600). The other cases are the pre-existing help/version handshakes
/// and an explicit `NESSION_NO_UPDATE_CHECK`.
pub fn should_skip_background_check(args: &[OsString]) -> bool {
    if std::env::var("NESSION_NO_UPDATE_CHECK").is_ok() {
        return true;
    }
    if is_logs_invocation(args) {
        return true;
    }
    args.iter().any(|arg| {
        matches!(
            arg.to_str(),
            Some("--help" | "-h" | "help" | "--version" | "-V" | "--upgrade-config-check")
        )
    })
}

/// Whether this invocation is the read-only `agent|server logs` command.
///
/// Used before Clap parses (main) and by the version dispatcher. It must be
/// tolerant of global flags and their values.
pub fn is_logs_invocation(args: &[OsString]) -> bool {
    logs_family(args).is_some()
}

fn logs_family(args: &[OsString]) -> Option<String> {
    let (family, action) = two_command_tokens(args)?;
    if action == "logs" && matches!(family.as_str(), "agent" | "server") {
        Some(family)
    } else {
        None
    }
}

/// The first two non-flag command tokens, skipping the global flags that take
/// a value so a value named `logs` cannot masquerade as the action.
fn two_command_tokens(args: &[OsString]) -> Option<(String, String)> {
    let mut tokens = Vec::new();
    let mut index = 1;
    while let Some(value) = args.get(index) {
        let token = value.to_str()?;
        if matches!(token, "--server-url" | "--auth-token" | "--profile") {
            index += 2;
            continue;
        }
        if token.starts_with('-') || token.starts_with('+') {
            index += 1;
            continue;
        }
        tokens.push(token.to_string());
        if tokens.len() == 2 {
            break;
        }
        index += 1;
    }
    match tokens.as_slice() {
        [family, action] => Some((family.clone(), action.clone())),
        _ => None,
    }
}

/// Probe whether the archived CLI knows the `logs` leaf.
///
/// A help probe is a normal child process that exits before doing any work;
/// its output is discarded. A release without the command exits non-zero (or
/// with no help), and the caller takes the read-only fallback.
fn archive_supports_logs(cli: &Path, home: &Path, family: &str) -> bool {
    Command::new(cli)
        .args([family, "logs", "--help"])
        .env(nession_common::paths::NESSION_HOME_ENV, home)
        .env(NESSION_VERSION_DISPATCHED_ENV, "1")
        .env_remove(NESSION_VERSION_ENV)
        .env("NESSION_NO_UPDATE_CHECK", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Run the Current CLI against the selected archive home with the archive's
/// path, without changing Current or touching the archive.
fn dispatch_logs_read_only(args: &[OsString], version: &Version, home: &Path) -> Result<()> {
    let exe = std::env::current_exe().context("cannot resolve the Current CLI executable")?;
    let mut command = Command::new(&exe);
    command
        .args(args.get(1..).unwrap_or(&[]))
        .env(nession_common::paths::NESSION_HOME_ENV, home)
        .env_remove(NESSION_VERSION_ENV)
        .env(NESSION_VERSION_DISPATCHED_ENV, "1")
        .env("NESSION_NO_UPDATE_CHECK", "1");

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        Err(anyhow::Error::new(error).context(format!(
            "failed to run the Current CLI at {} for release {version} logs",
            exe.display()
        )))
    }
    #[cfg(not(unix))]
    {
        let status = command.status().with_context(|| {
            format!(
                "failed to run the Current CLI at {} for release {version} logs",
                exe.display()
            )
        })?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

/// The `(family, action)` pair when the command is a dangerous lifecycle
/// command that the selected release must share a contract for.
fn lifecycle_command(args: &[OsString]) -> Option<(String, String)> {
    let mut tokens = Vec::new();
    let mut index = 1;
    while let Some(value) = args.get(index) {
        let token = value.to_str()?;
        if matches!(token, "--server-url" | "--auth-token" | "--profile") {
            index += 2;
            continue;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        tokens.push(token.to_string());
        if tokens.len() == 2 {
            break;
        }
        index += 1;
    }
    let [family, action] = tokens.as_slice() else {
        return None;
    };
    if !matches!(family.as_str(), "agent" | "server") {
        return None;
    }
    if !matches!(action.as_str(), "start" | "restart" | "status" | "stop") {
        return None;
    }
    Some((family.clone(), action.clone()))
}

/// Require the archived CLI to advertise the shared lifecycle contract and to
/// report the release its directory claims.
///
/// The probe is a normal child process, not an `exec`: a refusal must leave the
/// caller's process intact so it can print the migration hint.
fn verify_archived_lifecycle_contract(
    cli: &Path,
    version: &Version,
    home: &Path,
    family: &str,
    action: &str,
) -> Result<()> {
    let output = Command::new(cli)
        .arg("--lifecycle-contract")
        .env(nession_common::paths::NESSION_HOME_ENV, home)
        .env(NESSION_VERSION_DISPATCHED_ENV, "1")
        .env_remove(NESSION_VERSION_ENV)
        .env("NESSION_NO_UPDATE_CHECK", "1")
        .output()
        .with_context(|| {
            format!(
                "cannot run the archived CLI at {} to verify its lifecycle contract",
                cli.display()
            )
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let advertised = stdout.split_whitespace().next();
    if !output.status.success() || advertised != Some(crate::lifecycle::CONTRACT_TOKEN) {
        bail!(
            "release {version} does not advertise the shared lifecycle contract (it predates \
             the cross-release lifecycle lock, PID identity and single-active gate).\n\
             `nession {family} {action}` is refused instead of executing it blindly; a second \
             daemon or a different release's state would be unsafe.\n\
             Fix: run `nession {family} {action}` on Current (without a version selector), or \
             install a release that supports versioned lifecycle commands."
        );
    }
    let reported = stdout
        .split_whitespace()
        .nth(1)
        .and_then(|value| normalize_version(value).ok());
    match reported {
        Some(reported) if reported == *version => Ok(()),
        Some(reported) => bail!(
            "the archived CLI at {} reports release {reported} but is installed as {version}; \
             refusing `nession {family} {action}` on a mislabeled release.\n\
             Fix: reinstall {version}, or remove the archive directory after preserving any \
             state it holds.",
            cli.display()
        ),
        None => bail!(
            "the archived CLI at {} did not report a release version (contract output: {:?}); \
             refusing `nession {family} {action}` because the release cannot be proven.",
            cli.display(),
            stdout.trim()
        ),
    }
}

/// The command families whose target resolution may depend on the
/// installation's client connection context (#4682).
fn client_profile_family(args: &[OsString]) -> Option<String> {
    let family = command_name(args)?;
    if matches!(family.as_str(), "profile" | "agents" | "sessions") {
        Some(family)
    } else {
        None
    }
}

/// Probe whether the archived CLI advertises read-only client-context
/// consumption (`nession --client-profile-contract`).
fn archive_supports_client_profiles(cli: &Path, home: &Path) -> bool {
    let output = Command::new(cli)
        .arg("--client-profile-contract")
        .env(nession_common::paths::NESSION_HOME_ENV, home)
        .env(NESSION_VERSION_DISPATCHED_ENV, "1")
        .env_remove(NESSION_VERSION_ENV)
        .env("NESSION_NO_UPDATE_CHECK", "1")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            output.status.success()
                && stdout.split_whitespace().next()
                    == Some(crate::profile::CLIENT_PROFILE_CONTRACT_TOKEN)
        }
        Err(_) => false,
    }
}

/// Whether the invocation names an explicit URL target (flag or ambient env),
/// the legacy path an archive without profile support can still honor safely.
fn has_explicit_url(args: &[OsString]) -> bool {
    args.iter()
        .skip(1)
        .any(|arg| arg == "--server-url" || arg.to_string_lossy().starts_with("--server-url="))
        || std::env::var_os(crate::connection::SERVER_URL_ENV).is_some()
        || std::env::var_os(crate::connection::SERVER_URL_LEGACY_ENV).is_some()
}

/// Whether the invocation passes the `--profile` flag (either spelling).
fn has_profile_flag(args: &[OsString]) -> bool {
    args.iter()
        .skip(1)
        .any(|arg| arg == "--profile" || arg.to_string_lossy().starts_with("--profile="))
}

/// Refuse a profile-dependent invocation on an archive that predates client
/// profiles, with actionable version/explicit-target guidance (#4682).
///
/// Explicit URL flag/env invocations keep the legacy behavior and pass; an
/// implicit invocation that would consult the installation's client context
/// (a `--profile` flag, `NESSION_PROFILE`, or any persisted client store) is
/// refused rather than silently reinterpreted as the legacy loopback.
fn verify_unsupported_archive_client_context(
    args: &[OsString],
    version: &Version,
    family: &str,
) -> Result<()> {
    if family == "profile" {
        bail!(
            "release {version} predates client connection profiles; `nession profile …` is \
             refused on it. Run profile management on Current (without a version selector)."
        );
    }
    if has_profile_flag(args) {
        bail!(
            "release {version} does not support --profile; it would reject the flag without \
             honoring the selection. Run the command on Current (without a version selector), \
             or pass --server-url <url> explicitly."
        );
    }
    if has_explicit_url(args) {
        return Ok(());
    }
    if std::env::var_os(crate::connection::PROFILE_ENV).is_some() {
        bail!(
            "release {version} predates client connection profiles and {} is set; the archive \
             would ignore the selection and dial the legacy default. Run the command on \
             Current, or pass --server-url <url> explicitly.",
            crate::connection::PROFILE_ENV
        );
    }
    let loc = crate::profile::store::StoreLocation {
        home: nession_common::paths::nession_home()?,
        read_only: true,
    };
    match crate::profile::store::load(&loc) {
        Ok(Some(file)) if !file.profiles.is_empty() => bail!(
            "release {version} predates client connection profiles, but this installation has \
             a client store (current selection: {}). The archive would ignore it and dial the \
             legacy default. Run the command on Current, or pass --server-url <url> explicitly.",
            file.current_profile.as_deref().unwrap_or("none")
        ),
        Ok(_) => Ok(()),
        Err(error) => bail!(
            "release {version} predates client connection profiles and the installation's \
             client store cannot be validated ({error:#}); refusing to dispatch an implicit \
             target. Run on Current to repair the store, or pass --server-url <url> explicitly."
        ),
    }
}

/// The command token Clap would dispatch, skipping global flags and their
/// values so a flag value named `install` cannot masquerade as the command.
fn command_name(args: &[OsString]) -> Option<String> {
    let mut index = 1;
    while let Some(value) = args.get(index) {
        let token = value.to_str().unwrap_or("");
        if matches!(token, "--server-url" | "--auth-token" | "--profile") {
            index += 2;
            continue;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        return Some(token.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn a_v_prefix_is_normalized() {
        assert_eq!(
            normalize_version("v0.35.0").unwrap(),
            Version::new(0, 35, 0)
        );
        assert_eq!(normalize_version("0.35.0").unwrap(), Version::new(0, 35, 0));
    }

    #[test]
    fn invalid_versions_are_rejected() {
        assert!(normalize_version("latest").is_err());
        assert!(normalize_version("1.2").is_err());
        assert!(normalize_version("v").is_err());
    }

    #[test]
    fn the_command_skips_global_flag_values() {
        let args = vec![
            OsString::from("nession"),
            OsString::from("--server-url"),
            OsString::from("install"),
            OsString::from("sessions"),
            OsString::from("list"),
        ];
        assert_eq!(command_name(&args).as_deref(), Some("sessions"));
    }

    #[test]
    fn dangerous_lifecycle_commands_are_recognised() {
        let args = |tokens: &[&str]| {
            std::iter::once("nession")
                .chain(tokens.iter().copied())
                .map(OsString::from)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            lifecycle_command(&args(&["agent", "restart"])),
            Some(("agent".into(), "restart".into()))
        );
        assert_eq!(
            lifecycle_command(&args(&["--server-url", "ws://x", "server", "stop"])),
            Some(("server".into(), "stop".into()))
        );
        assert_eq!(lifecycle_command(&args(&["agent", "logs"])), None);
        assert_eq!(lifecycle_command(&args(&["sessions", "list"])), None);
        assert_eq!(
            lifecycle_command(&args(&["agent", "install-service"])),
            None,
            "service registration is not a direct lifecycle action"
        );
    }

    #[cfg(unix)]
    fn probe_script(dir: &std::path::Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        // In parallel coverage tests, a fork can inherit a writable handle
        // even after the parent closes/renames the staging inode (ETXTBSY).
        // Have a child process install the executable: the parent never holds
        // a writable descriptor to the inode that another test may execute.
        // This matches the Agent integration fixture installer (#3609).
        let source = dir.join("nession.source");
        let path = dir.join("nession");
        std::fs::write(&source, body).unwrap();
        let copy = std::process::Command::new("cp")
            .arg(&source)
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            copy.status.success(),
            "cannot install archived CLI fixture: {}",
            String::from_utf8_lossy(&copy.stderr)
        );
        std::fs::remove_file(&source).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn a_contract_aware_archived_cli_passes_the_probe() {
        let dir = tempfile::tempdir().unwrap();
        let cli = probe_script(
            dir.path(),
            &format!(
                "#!/bin/sh\necho \"{} 0.35.0\"\n",
                crate::lifecycle::CONTRACT_TOKEN
            ),
        );
        verify_archived_lifecycle_contract(
            &cli,
            &Version::new(0, 35, 0),
            dir.path(),
            "agent",
            "start",
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_legacy_archived_cli_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let cli = probe_script(dir.path(), "#!/bin/sh\nexit 2\n");
        let error = verify_archived_lifecycle_contract(
            &cli,
            &Version::new(0, 34, 0),
            dir.path(),
            "agent",
            "start",
        )
        .unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("does not advertise"), "{message}");
        assert!(message.contains("refused"), "{message}");
    }

    #[cfg(unix)]
    #[test]
    fn a_mislabeled_archived_cli_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let cli = probe_script(
            dir.path(),
            &format!(
                "#!/bin/sh\necho \"{} 0.34.0\"\n",
                crate::lifecycle::CONTRACT_TOKEN
            ),
        );
        let error = verify_archived_lifecycle_contract(
            &cli,
            &Version::new(0, 35, 0),
            dir.path(),
            "server",
            "restart",
        )
        .unwrap_err();
        assert!(
            format!("{error:#}").contains("reports release 0.34.0"),
            "{error:#}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_probe_without_a_version_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let cli = probe_script(
            dir.path(),
            &format!("#!/bin/sh\necho \"{}\"\n", crate::lifecycle::CONTRACT_TOKEN),
        );
        let error = verify_archived_lifecycle_contract(
            &cli,
            &Version::new(0, 35, 0),
            dir.path(),
            "agent",
            "status",
        )
        .unwrap_err();
        assert!(
            format!("{error:#}").contains("did not report a release version"),
            "{error:#}"
        );
    }

    #[test]
    fn manage_current_is_recognised() {
        let args = vec![
            OsString::from("nession"),
            OsString::from("install"),
            OsString::from("0.35.0"),
        ];
        assert_eq!(command_name(&args).as_deref(), Some("install"));
    }

    fn argv(tokens: &[&str]) -> Vec<OsString> {
        std::iter::once("nession")
            .chain(tokens.iter().copied())
            .map(OsString::from)
            .collect()
    }

    #[test]
    fn data_touching_commands_are_recognised() {
        for tokens in [
            vec!["agent", "start"],
            vec!["agent", "restart"],
            vec!["agent", "stop"],
            vec!["agent", "install-service"],
            vec!["server", "start"],
            vec!["server", "restart"],
            vec!["sessions", "create"],
            vec!["sessions", "attach"],
            vec!["sessions", "kill"],
            vec!["config", "agent", "init"],
            vec!["config", "server", "set"],
        ] {
            assert!(
                mutating_command(&argv(&tokens)).is_some(),
                "{tokens:?} must be gated"
            );
        }
    }

    #[test]
    fn read_only_commands_stay_available_on_any_archive() {
        for tokens in [
            vec!["agent", "status"],
            vec!["agent", "logs"],
            vec!["server", "status"],
            vec!["server", "logs"],
            vec!["sessions", "list"],
            vec!["agents", "list"],
            vec!["config", "agent", "show"],
            vec!["config", "server", "show"],
            vec!["version", "list"],
        ] {
            assert_eq!(
                mutating_command(&argv(&tokens)),
                None,
                "{tokens:?} is read-only inspection"
            );
        }
        assert_eq!(
            mutating_command(&argv(&["--server-url", "ws://x", "sessions", "list"])),
            None,
            "global flag values must not shift the classifier"
        );
    }

    fn manifest_fixture(
        state_complete: bool,
        deps: Vec<String>,
    ) -> crate::update::snapshot::Manifest {
        use crate::update::snapshot::{CoverageClass, CoverageComponent, CoverageEntry};
        let coverage = if state_complete {
            vec![CoverageEntry::new(
                "agent/identity",
                CoverageClass::Captured,
                CoverageComponent::Agent,
                "captured",
            )]
        } else {
            vec![CoverageEntry::new(
                "server/server.db",
                CoverageClass::Missing,
                CoverageComponent::Server,
                "consistent backup failed",
            )]
        };
        crate::update::snapshot::Manifest {
            schema: crate::update::snapshot::MANIFEST_SCHEMA,
            release: "0.35.0".into(),
            created_by: crate::update::UPGRADE_CONTRACT_TOKEN.into(),
            binaries: BTreeMap::new(),
            configs: BTreeMap::new(),
            state: BTreeMap::new(),
            references: Vec::new(),
            coverage,
            gaps: if state_complete {
                Vec::new()
            } else {
                vec!["server/server.db: consistent backup failed".into()]
            },
            external_dependencies: deps,
            state_complete,
        }
    }

    #[test]
    fn a_binary_only_archive_is_refused_for_mutating_commands() {
        let dir = tempfile::tempdir().unwrap();
        for name in RELEASE_BINARIES {
            let path = dir.path().join("bin").join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "binary").unwrap();
        }
        assert_eq!(
            archive_state_coverage(dir.path()),
            StateCoverage::NoManifest
        );
        let error = verify_archive_state_coverage(
            dir.path(),
            &Version::new(0, 35, 0),
            "agent start",
            crate::update::snapshot::CoverageComponent::Agent,
        )
        .unwrap_err();
        let message = format!("{error:#}");
        assert!(
            message.contains("without a proven state snapshot"),
            "{message}"
        );
        assert!(message.contains("version inspect 0.35.0"), "{message}");
        assert!(message.contains("version recover 0.35.0"), "{message}");
    }

    #[test]
    fn a_proven_manifest_allows_mutating_commands() {
        let dir = tempfile::tempdir().unwrap();
        crate::update::snapshot::write_manifest(dir.path(), &manifest_fixture(true, Vec::new()))
            .unwrap();
        assert_eq!(archive_state_coverage(dir.path()), StateCoverage::Proven);
        verify_archive_state_coverage(
            dir.path(),
            &Version::new(0, 35, 0),
            "sessions create",
            crate::update::snapshot::CoverageComponent::Agent,
        )
        .unwrap();
    }

    fn client_argv(tokens: &[&str]) -> Vec<OsString> {
        std::iter::once("nession")
            .chain(tokens.iter().copied())
            .map(OsString::from)
            .collect()
    }

    #[test]
    fn client_profile_families_are_recognised_without_flag_value_masquerade() {
        assert_eq!(
            client_profile_family(&client_argv(&["profile", "list"])).as_deref(),
            Some("profile")
        );
        assert_eq!(
            client_profile_family(&client_argv(&["sessions", "list"])).as_deref(),
            Some("sessions")
        );
        assert_eq!(
            client_profile_family(&client_argv(&["agents", "list"])).as_deref(),
            Some("agents")
        );
        assert_eq!(
            client_profile_family(&client_argv(&["--profile", "install", "sessions", "list"]))
                .as_deref(),
            Some("sessions"),
            "a profile named like a command must not shift the classifier"
        );
        assert_eq!(
            client_profile_family(&client_argv(&["agent", "status"])),
            None
        );
        assert_eq!(
            client_profile_family(&client_argv(&["version", "list"])),
            None
        );
    }

    #[test]
    fn explicit_url_and_profile_flags_are_detected_in_both_spellings() {
        assert!(has_profile_flag(&client_argv(&[
            "--profile",
            "home",
            "sessions",
            "list"
        ])));
        assert!(has_profile_flag(&client_argv(&[
            "--profile=home",
            "sessions",
            "list"
        ])));
        assert!(!has_profile_flag(&client_argv(&["sessions", "list"])));
        assert!(has_explicit_url(&client_argv(&[
            "--server-url",
            "ws://x",
            "sessions",
            "list"
        ])));
        assert!(has_explicit_url(&client_argv(&[
            "--server-url=ws://x",
            "sessions",
            "list"
        ])));
    }

    #[cfg(unix)]
    #[test]
    fn a_profile_aware_archived_cli_passes_the_client_contract_probe() {
        let dir = tempfile::tempdir().unwrap();
        let cli = probe_script(
            dir.path(),
            &format!(
                "#!/bin/sh\necho \"{} 0.35.0\"\n",
                crate::profile::CLIENT_PROFILE_CONTRACT_TOKEN
            ),
        );
        assert!(archive_supports_client_profiles(&cli, dir.path()));
        let legacy = probe_script(dir.path(), "#!/bin/sh\nexit 2\n");
        assert!(!archive_supports_client_profiles(&legacy, dir.path()));
    }

    /// The unsupported-archive decision matrix (#4682): explicit URL/env
    /// invocations keep legacy behavior; implicit profile-dependent ones are
    /// refused with guidance, never silently reinterpreted as localhost.
    #[test]
    fn an_unsupported_archive_refuses_implicit_profile_context() {
        let _env = crate::test_env::lock_blocking();
        let _url = crate::test_env::EnvSetting::unset(crate::connection::SERVER_URL_ENV);
        let _url_legacy =
            crate::test_env::EnvSetting::unset(crate::connection::SERVER_URL_LEGACY_ENV);
        let _profile_env = crate::test_env::EnvSetting::unset(crate::connection::PROFILE_ENV);
        let dir = tempfile::tempdir().unwrap();
        let _home = crate::test_env::EnvSetting::set(
            nession_common::paths::NESSION_HOME_ENV,
            dir.path().to_str().unwrap(),
        );
        let version = Version::new(0, 34, 0);

        // profile management on a legacy archive is refused outright.
        let error = verify_unsupported_archive_client_context(
            &client_argv(&["profile", "list"]),
            &version,
            "profile",
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("predates client connection profiles"));

        // --profile on a legacy archive is refused with explicit guidance.
        let error = verify_unsupported_archive_client_context(
            &client_argv(&["--profile", "home", "sessions", "list"]),
            &version,
            "sessions",
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("does not support --profile"));

        // An explicit URL flag keeps the legacy path, even with NESSION_PROFILE.
        let _profile_env = crate::test_env::EnvSetting::set(crate::connection::PROFILE_ENV, "home");
        verify_unsupported_archive_client_context(
            &client_argv(&["--server-url", "ws://explicit:1/ws", "sessions", "list"]),
            &version,
            "sessions",
        )
        .unwrap();
        // An ambient URL also keeps the legacy path.
        let _url = crate::test_env::EnvSetting::set(
            crate::connection::SERVER_URL_ENV,
            "ws://ambient:1/ws",
        );
        verify_unsupported_archive_client_context(
            &client_argv(&["sessions", "list"]),
            &version,
            "sessions",
        )
        .unwrap();
        drop(_url);
        let _url = crate::test_env::EnvSetting::unset(crate::connection::SERVER_URL_ENV);

        // NESSION_PROFILE alone is profile-dependent: refused.
        let error = verify_unsupported_archive_client_context(
            &client_argv(&["sessions", "list"]),
            &version,
            "sessions",
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("NESSION_PROFILE"));
        drop(_profile_env);
        let _profile_env = crate::test_env::EnvSetting::unset(crate::connection::PROFILE_ENV);

        // No store: legacy loopback behavior is preserved.
        verify_unsupported_archive_client_context(
            &client_argv(&["sessions", "list"]),
            &version,
            "sessions",
        )
        .unwrap();

        // A persisted store with a selection is profile-dependent: refused.
        std::fs::write(
            dir.path().join("client-config.toml"),
            "schema_version = 1\ncurrent_profile = \"home\"\n\
             [profiles.home]\nserver_url = \"ws://remote:9/ws\"\n",
        )
        .unwrap();
        let error = verify_unsupported_archive_client_context(
            &client_argv(&["sessions", "list"]),
            &version,
            "sessions",
        )
        .unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("client store"), "{message}");
        assert!(message.contains("home"), "{message}");

        // A corrupt store cannot be proven safe: refused, never overwritten.
        std::fs::write(dir.path().join("client-config.toml"), "corrupt {{{").unwrap();
        let error = verify_unsupported_archive_client_context(
            &client_argv(&["sessions", "list"]),
            &version,
            "sessions",
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("cannot be validated"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("client-config.toml")).unwrap(),
            "corrupt {{{"
        );
    }

    #[test]
    fn an_incomplete_or_dependent_manifest_is_refused() {
        use crate::update::snapshot::CoverageComponent;
        let dir = tempfile::tempdir().unwrap();
        // A failed Server DB backup refuses Server commands...
        crate::update::snapshot::write_manifest(dir.path(), &manifest_fixture(false, Vec::new()))
            .unwrap();
        let error = verify_archive_state_coverage(
            dir.path(),
            &Version::new(0, 35, 0),
            "server start",
            CoverageComponent::Server,
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("unproven state coverage"));

        // ...but an external dependency refuses the affected component too.
        crate::update::snapshot::write_manifest(
            dir.path(),
            &manifest_fixture(true, vec!["db_path".into()]),
        )
        .unwrap();
        let error = verify_archive_state_coverage(
            dir.path(),
            &Version::new(0, 35, 0),
            "server start",
            CoverageComponent::Server,
        )
        .unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("does not own"), "{message}");
        assert!(message.contains("db_path"), "{message}");
    }

    #[test]
    fn a_server_only_gap_does_not_block_a_proven_agent() {
        use crate::update::snapshot::{
            write_manifest, CoverageClass, CoverageComponent, CoverageEntry, Manifest,
            MANIFEST_SCHEMA,
        };
        let dir = tempfile::tempdir().unwrap();
        // Agent identity captured; Server DB missing. Agent commands must run.
        let manifest = Manifest {
            schema: MANIFEST_SCHEMA,
            release: "0.35.0".into(),
            created_by: crate::update::UPGRADE_CONTRACT_TOKEN.into(),
            binaries: BTreeMap::new(),
            configs: BTreeMap::new(),
            state: BTreeMap::new(),
            references: Vec::new(),
            coverage: vec![
                CoverageEntry::new(
                    "agent/identity",
                    CoverageClass::Captured,
                    CoverageComponent::Agent,
                    "captured",
                ),
                CoverageEntry::new(
                    "server/server.db",
                    CoverageClass::Missing,
                    CoverageComponent::Server,
                    "backup failed",
                ),
            ],
            gaps: vec!["server/server.db: backup failed".into()],
            external_dependencies: Vec::new(),
            state_complete: false,
        };
        write_manifest(dir.path(), &manifest).unwrap();
        assert_eq!(
            archive_component_coverage(dir.path(), CoverageComponent::Agent),
            StateCoverage::Proven
        );
        assert!(matches!(
            archive_component_coverage(dir.path(), CoverageComponent::Server),
            StateCoverage::Unproven { .. }
        ));
        verify_archive_state_coverage(
            dir.path(),
            &Version::new(0, 35, 0),
            "agent start",
            CoverageComponent::Agent,
        )
        .unwrap();
    }

    #[test]
    fn command_component_maps_families() {
        use crate::update::snapshot::CoverageComponent;
        assert_eq!(
            command_component(&argv(&["agent", "start"])),
            Some(CoverageComponent::Agent)
        );
        assert_eq!(
            command_component(&argv(&["server", "start"])),
            Some(CoverageComponent::Server)
        );
        assert_eq!(
            command_component(&argv(&["sessions", "create"])),
            Some(CoverageComponent::Agent)
        );
        assert_eq!(
            command_component(&argv(&["config", "server", "set"])),
            Some(CoverageComponent::Server)
        );
        assert_eq!(
            command_component(&argv(&["config", "agent", "init"])),
            Some(CoverageComponent::Agent)
        );
    }
}
