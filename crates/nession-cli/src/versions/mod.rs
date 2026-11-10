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

/// Install directory override. `scripts/install.sh` already honours this name;
/// the CLI uses it for the managed release directory so tests and automated
/// installs never touch the binary that is running them.
pub const NESSION_INSTALL_DIR_ENV: &str = "NESSION_INSTALL_DIR";

const VERSIONS_DIR: &str = "versions";
const BIN_NAME: &str = "nession";

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
        if entry.path().join("bin").join(BIN_NAME).is_file() {
            versions.push(version);
        }
    }
    versions.sort();
    Ok(versions)
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

    let cli = archived_cli(&version)?;
    if !cli.is_file() {
        bail!(
            "release {version} is not installed (missing {}); run `nession install {version}`",
            cli.display()
        );
    }
    let home = version_home(&version)?;
    let mut command = Command::new(&cli);
    command
        .args(args.get(1..).unwrap_or(&[]))
        .env(nession_common::paths::NESSION_HOME_ENV, &home)
        .env_remove(NESSION_VERSION_ENV)
        .env(NESSION_VERSION_DISPATCHED_ENV, "1")
        .env("NESSION_NO_UPDATE_CHECK", "1");

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

/// The command token Clap would dispatch, skipping global flags and their
/// values so a flag value named `install` cannot masquerade as the command.
fn command_name(args: &[OsString]) -> Option<String> {
    let mut index = 1;
    while let Some(value) = args.get(index) {
        let token = value.to_str().unwrap_or("");
        if matches!(token, "--server-url" | "--auth-token") {
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
    fn manage_current_is_recognised() {
        let args = vec![
            OsString::from("nession"),
            OsString::from("install"),
            OsString::from("0.35.0"),
        ];
        assert_eq!(command_name(&args).as_deref(), Some("install"));
    }
}
