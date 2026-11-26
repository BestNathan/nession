//! Target-owned configuration compatibility probe (#4592 §3).
//!
//! `nession --upgrade-config-check <agent|server> <path>` is the hidden
//! capability the upgrade transaction runs against the **target** release's
//! binary, on staged copies of the retained configs. The target's own schema
//! and validators decide compatibility — the installer never guesses.
//!
//! The probe is pure: it parses and validates, and writes nothing. In
//! particular it must not mint an Agent identity or create any file; a
//! validation probe that mutates state would defeat fail-closed preflight.
//!
//! Diagnostics are sanitized: TOML parse failures report a location only
//! (never the offending source line, which may contain credentials), and
//! validation failures report the field-level rule message.

use std::ffi::OsString;
use std::path::Path;

/// Handle `--upgrade-config-check <kind> <path>` from raw args.
///
/// Returns `Some(exit_code)` when the probe was requested (0 ok, 1 rejected,
/// 2 misuse), or `None` when the args name a normal command. Keeps the
/// entrypoint thin: the probe's parsing and diagnostics live here.
pub fn probe_exit_code(args: &[OsString]) -> Option<i32> {
    let position = args
        .iter()
        .position(|argument| argument == "--upgrade-config-check")?;
    let kind = args.get(position + 1).and_then(|a| a.to_str());
    let path = args.get(position + 2).and_then(|a| a.to_str());
    Some(match (kind, path) {
        (Some(kind), Some(path)) => match check(kind, Path::new(path)) {
            Ok(()) => {
                println!("ok");
                0
            }
            Err(diagnostic) => {
                eprintln!("{diagnostic}");
                1
            }
        },
        _ => {
            eprintln!("usage: nession --upgrade-config-check <agent|server> <path>");
            2
        }
    })
}

/// Validate one retained config with this binary's own schema.
///
/// Returns `Ok(())` when the target release can losslessly parse and validate
/// the file, or a sanitized diagnostic string when it cannot.
pub fn check(kind: &str, path: &Path) -> Result<(), String> {
    let content = std::fs::read_to_string(path)
        .map_err(|_| format!("cannot read the staged {kind} config"))?;
    match kind {
        "agent" => {
            let config: nession_agent::config::AgentConfig =
                parse(&content).map_err(|location| format!("agent config {location}"))?;
            config
                .validate()
                .map_err(|error| format!("agent config rejected: {error}"))
        }
        "server" => {
            let config: nession_common::config::ServerConfig =
                parse(&content).map_err(|location| format!("server config {location}"))?;
            config
                .validate()
                .map_err(|error| format!("server config rejected: {error}"))
        }
        other => Err(format!(
            "unknown config kind {other:?}; expected agent or server"
        )),
    }
}

/// Parse with a location-only diagnostic: the toml crate's default message
/// embeds the offending source text, which can include secrets.
fn parse<T: serde::de::DeserializeOwned>(content: &str) -> Result<T, String> {
    toml::from_str(content).map_err(|error: toml::de::Error| match error.span() {
        Some(span) => {
            let prefix = &content[..span.start.min(content.len())];
            let line = prefix.matches('\n').count() + 1;
            let column = prefix.rsplit('\n').next().map(str::len).unwrap_or(0) + 1;
            format!("is not valid TOML for this release (line {line}, column {column})")
        }
        None => "is not valid TOML for this release".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn staged(dir: &TempDir, body: &str) -> std::path::PathBuf {
        let path = dir.path().join("config.toml");
        std::fs::write(&path, body).unwrap();
        path
    }

    const MINIMAL_AGENT: &str = "server_url = \"ws://127.0.0.1:8443\"\nauth_token = \"t\"\n";
    const MINIMAL_SERVER: &str = "listen_address = \"127.0.0.1:19090\"\n\
                                  tls_cert_path = \"\"\n\
                                  tls_key_path = \"\"\n\
                                  auth_token = \"t\"\n";

    #[test]
    fn a_valid_minimal_agent_config_passes() {
        let dir = TempDir::new().unwrap();
        let path = staged(&dir, MINIMAL_AGENT);
        assert!(check("agent", &path).is_ok());
    }

    #[test]
    fn a_valid_minimal_server_config_passes() {
        let dir = TempDir::new().unwrap();
        let path = staged(&dir, MINIMAL_SERVER);
        assert!(check("server", &path).is_ok());
    }

    #[test]
    fn a_parse_failure_reports_location_without_the_secret() {
        let dir = TempDir::new().unwrap();
        let path = staged(
            &dir,
            "auth_token = \"super-secret-value\"\nbroken = [unterminated\n",
        );
        let error = check("server", &path).unwrap_err();
        assert!(error.contains("line 2"), "{error}");
        assert!(
            !error.contains("super-secret-value"),
            "the diagnostic must not echo config values: {error}"
        );
        assert!(
            !error.contains("unterminated"),
            "the diagnostic must not echo the offending source: {error}"
        );
    }

    #[test]
    fn a_validation_failure_names_the_rule() {
        let dir = TempDir::new().unwrap();
        let path = staged(&dir, &format!("{MINIMAL_SERVER}terminal_cols = 3\n"));
        let error = check("server", &path).unwrap_err();
        assert!(error.contains("rejected"), "{error}");
    }

    #[test]
    fn probe_exit_code_routes_raw_args() {
        use std::ffi::OsString;
        let args = |values: &[&str]| values.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            probe_exit_code(&args(&["nession", "version", "list"])),
            None
        );
        assert_eq!(
            probe_exit_code(&args(&["nession", "--upgrade-config-check"])),
            Some(2),
            "missing kind/path is misuse"
        );
        let dir = TempDir::new().unwrap();
        let path = staged(&dir, MINIMAL_AGENT);
        let ok = args(&[
            "nession",
            "--upgrade-config-check",
            "agent",
            &path.display().to_string(),
        ]);
        assert_eq!(probe_exit_code(&ok), Some(0));
        let bad = staged(&dir, "broken = [unterminated\n");
        let rejected = args(&[
            "nession",
            "--upgrade-config-check",
            "agent",
            &bad.display().to_string(),
        ]);
        assert_eq!(probe_exit_code(&rejected), Some(1));
    }

    #[test]
    fn an_unknown_kind_is_refused() {
        let dir = TempDir::new().unwrap();
        let path = staged(&dir, "");
        let error = check("database", &path).unwrap_err();
        assert!(error.contains("unknown config kind"), "{error}");
    }

    #[test]
    fn the_probe_writes_nothing() {
        let dir = TempDir::new().unwrap();
        let agent = dir.path().join("agent.toml");
        let server = dir.path().join("server.toml");
        std::fs::write(&agent, MINIMAL_AGENT).unwrap();
        std::fs::write(&server, MINIMAL_SERVER).unwrap();
        check("agent", &agent).unwrap();
        check("server", &server).unwrap();
        assert_eq!(std::fs::read_to_string(&agent).unwrap(), MINIMAL_AGENT);
        assert_eq!(std::fs::read_to_string(&server).unwrap(), MINIMAL_SERVER);
        // No identity or side files may appear next to the staged copies.
        let mut entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        entries.sort();
        assert_eq!(entries, vec!["agent.toml", "server.toml"]);
    }
}
