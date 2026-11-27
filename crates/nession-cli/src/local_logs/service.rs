//! The managed-service log source.
//!
//! The Agent may be run by systemd (Linux) or launchd (macOS). Those captures
//! are a different source from the runtime files:
//!
//! - Linux: the systemd **user** journal (`journalctl --user -u
//!   nession-agent.service`). Registration and, when the unit records one,
//!   the `NESSION_HOME` scope are verified before reading.
//! - macOS: the LaunchAgent's `StandardOutPath`/`StandardErrorPath`. New
//!   registrations write `~/.nession/agent/logs/service/launchd.{out,err}`;
//!   an existing registration that still points at the historical shared
//!   `/tmp/nession-agent.launchd.*` files is shown only when the installed
//!   plist actually references them, with a warning.
//!
//! The Server has no native managed service in this CLI; it reports that
//! source as unsupported instead of inventing one (#4600 SC-06).

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use nession_common::logging::LogComponent;
use std::path::{Path, PathBuf};

use crate::local_logs::query::LogQuery;

/// Where managed-service output can be read from.
#[derive(Debug, Clone)]
pub enum ServiceLogSource {
    /// Raw capture files, oldest first.
    Files { files: Vec<PathBuf>, legacy: bool },
    /// The systemd user journal for a verified unit.
    Journal { unit: String },
}

/// Resolve the service source for `component` under the resolved home.
pub fn resolve(component: LogComponent, home: &Path) -> Result<ServiceLogSource> {
    if component == LogComponent::Server {
        bail!(
            "the Server has no native managed service in this CLI, so service logs are \
             unsupported; use `nession server logs --source runtime`"
        );
    }
    #[cfg(target_os = "linux")]
    {
        resolve_journal(home)
    }
    #[cfg(target_os = "macos")]
    {
        resolve_macos_captures(home)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = home;
        bail!("managed-service logs are unsupported on this platform")
    }
}

impl ServiceLogSource {
    /// Locations to print for `--path`.
    pub fn path_lines(&self) -> Vec<String> {
        match self {
            Self::Files { files, .. } => files
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            Self::Journal { unit } => {
                vec![format!("journalctl --user -u {unit}")]
            }
        }
    }
}

/// The systemd unit name this CLI installs (also used by the service module).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) const AGENT_SYSTEMD_UNIT: &str = "nession-agent.service";

#[cfg(target_os = "linux")]
fn resolve_journal(home: &Path) -> Result<ServiceLogSource> {
    let unit_path = crate::service::registered_systemd_unit_path()?.ok_or_else(|| {
        anyhow::anyhow!(
            "the Agent autostart service is not installed for this user \
             (no {AGENT_SYSTEMD_UNIT} in the systemd user unit directory).\n\
             Fix: run `nession agent install-service`, then retry, or read \
             `--source runtime`."
        )
    })?;
    let content = std::fs::read_to_string(&unit_path)
        .with_context(|| format!("cannot read the registered unit {}", unit_path.display()))?;
    match unit_home_scope(&content) {
        Some(scope) => {
            let scope = PathBuf::from(scope);
            if scope != home {
                bail!(
                    "the registered {AGENT_SYSTEMD_UNIT} runs with NESSION_HOME={} but this \
                     command resolved {}. Refusing to present another home's service output.\n\
                     Fix: set NESSION_HOME={} or run `nession agent install-service` to \
                     re-register the service for this home.",
                    scope.display(),
                    home.display(),
                    scope.display()
                );
            }
        }
        None => eprintln!(
            "nession logs: the registered {AGENT_SYSTEMD_UNIT} does not pin NESSION_HOME; \
             the journal reflects the service manager's environment (unverified home scope)"
        ),
    }
    Ok(ServiceLogSource::Journal {
        unit: AGENT_SYSTEMD_UNIT.to_string(),
    })
}

/// The `Environment=NESSION_HOME=` value a unit records, when present.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn unit_home_scope(unit: &str) -> Option<String> {
    let prefix = format!("{}=", nession_common::paths::NESSION_HOME_ENV);
    let mut scope = None;
    for line in unit.lines() {
        let line = line.trim();
        let Some(value) = line.strip_prefix("Environment=") else {
            continue;
        };
        let value = value.trim_matches('"');
        if let Some(rest) = value.strip_prefix(&prefix) {
            // systemd applies later assignments over earlier ones.
            scope = Some(rest.to_string());
        }
    }
    scope
}

#[cfg(target_os = "macos")]
fn resolve_macos_captures(home: &Path) -> Result<ServiceLogSource> {
    let dir = LogComponent::Agent.service_dir_under(home);
    let files = crate::local_logs::discovery::service_capture_files(&dir)?;
    if !files.is_empty() {
        return Ok(ServiceLogSource::Files {
            files,
            legacy: false,
        });
    }

    // Nothing under the current capture directory. An installed plist may
    // still name the historical shared `/tmp` files; show those only when the
    // registration itself points at them.
    if let Some(plist_path) = crate::service::registered_launchd_plist_path()? {
        let plist = std::fs::read_to_string(&plist_path).with_context(|| {
            format!("cannot read the registered plist {}", plist_path.display())
        })?;
        let mut files = Vec::new();
        let mut legacy = false;
        for key in ["StandardOutPath", "StandardErrorPath"] {
            let Some(value) = plist_string_value(&plist, key) else {
                continue;
            };
            let path = PathBuf::from(value);
            if !path.exists() {
                continue;
            }
            let is_legacy = path.starts_with("/tmp");
            legacy |= is_legacy;
            eprintln!(
                "nession logs: the installed LaunchAgent ({}) captures {key}={}{}",
                plist_path.display(),
                path.display(),
                if is_legacy {
                    " (legacy shared path; reinstall the service to move it under the home)"
                } else {
                    ""
                }
            );
            files.push(path);
        }
        if !files.is_empty() {
            return Ok(ServiceLogSource::Files { files, legacy });
        }
    }

    bail!(
        "no managed-service capture was found under {}.\n\
         Fix: run `nession agent install-service` (new registrations write \
         launchd.out/launchd.err there), or read `--source runtime`.",
        dir.display()
    )
}

/// The `<string>` following `<key>key</key>` in a plist text.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn plist_string_value(plist: &str, key: &str) -> Option<String> {
    let key_tag = format!("<key>{key}</key>");
    let after_key = plist.find(&key_tag)? + key_tag.len();
    let rest = &plist[after_key..];
    let start = rest.find("<string>")? + "<string>".len();
    let rest = &rest[start..];
    let end = rest.find("</string>")?;
    Some(unescape_xml(&rest[..end]))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn unescape_xml(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Run the journal read for `query`.
pub async fn run_journal(query: &LogQuery, unit: &str) -> Result<()> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    let mut command = tokio::process::Command::new("journalctl");
    command
        .arg("--user")
        .arg("-u")
        .arg(unit)
        .arg("--no-pager")
        .arg("--output=cat")
        .arg("-n")
        .arg(query.tail.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(since) = query.since {
        command.arg("--since").arg(format_journal_time(since));
    }
    if let Some(until) = query.until {
        command.arg("--until").arg(format_journal_time(until));
    }
    if query.follow {
        command.arg("--follow");
    }
    let mut child = command.spawn().with_context(|| {
        "failed to execute `journalctl` — is systemd's journal client installed and available \
         on PATH?"
    })?;
    let stdout = child
        .stdout
        .take()
        .context("journalctl produced no readable stdout")?;
    let stderr = child
        .stderr
        .take()
        .context("journalctl produced no readable stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buffer = String::new();
        let _ = reader.read_to_string(&mut buffer).await;
        buffer
    });

    let mut lines = BufReader::new(stdout).lines();
    if query.follow {
        loop {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    let _ = child.kill().await;
                    break;
                }
                line = lines.next_line() => {
                    match line {
                        Ok(Some(line)) => println!("{line}"),
                        Ok(None) => break,
                        Err(error) => {
                            eprintln!("nession logs: cannot read journalctl output: {error}");
                            break;
                        }
                    }
                }
            }
        }
    } else {
        while let Some(line) = lines
            .next_line()
            .await
            .context("cannot read journalctl output")?
        {
            println!("{line}");
        }
    }
    let status = child.wait().await?;
    if let Ok(stderr) = stderr_task.await {
        if !stderr.trim().is_empty() {
            eprint!("{stderr}");
        }
    }
    if !status.success() && !query.follow {
        bail!(
            "`journalctl --user -u {unit}` failed with {status}.\n\
             Fix: check that a systemd user journal exists for this user \
             (`journalctl --user -u {unit}`), or read `--source runtime`."
        );
    }
    Ok(())
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn format_journal_time(time: DateTime<Utc>) -> String {
    time.format("%Y-%m-%d %H:%M:%S UTC").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_unit_home_scope_is_read_when_present() {
        let unit =
            "[Service]\nEnvironment=\"NESSION_HOME=/x\"\nEnvironment=\"NESSION_HOME=/home/me\"\n";
        assert_eq!(unit_home_scope(unit).as_deref(), Some("/home/me"));
        assert_eq!(unit_home_scope("[Service]\nExecStart=/bin/true\n"), None);
    }

    #[test]
    fn plist_values_are_extracted_and_unescaped() {
        let plist = "<dict>\n<key>StandardOutPath</key>\n  <string>/home/a &amp; b/out</string>\n\
                     <key>StandardErrorPath</key>\n  <string>/tmp/nession-agent.launchd.err</string>\n\
                     </dict>";
        assert_eq!(
            plist_string_value(plist, "StandardOutPath").as_deref(),
            Some("/home/a & b/out")
        );
        assert_eq!(
            plist_string_value(plist, "StandardErrorPath").as_deref(),
            Some("/tmp/nession-agent.launchd.err")
        );
        assert_eq!(plist_string_value(plist, "Missing"), None);
    }

    #[test]
    fn the_server_service_source_is_explicitly_unsupported() {
        let error = resolve(LogComponent::Server, Path::new("/home/me/.nession")).unwrap_err();
        assert!(format!("{error:#}").contains("unsupported"), "{error:#}");
    }
}
