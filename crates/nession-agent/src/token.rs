//! The Agent's durable inbound token (#3440).
//!
//! One stable, per-Agent secret gates the P2P listener and embedded MCP. It is
//! provisioned once, persists across restarts, and never regenerates on its
//! own. An explicit `agent_token` in the config file is the operator override;
//! the generated token lives beside that config file so an Agent identity and
//! its secret cannot be paired with another process by accident.
//!
//! Rotation is a restart: replace the configured value (or the token file) and
//! restart the Agent. Existing connections end with the process, and new ones
//! are verified against the new value — there is no live-socket re-auth path.

use anyhow::{bail, Context, Result};
use base64::Engine;
use nession_common::SecretString;
use rand::RngCore;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Bytes of randomness in a generated token (base64url, no padding).
const GENERATED_TOKEN_BYTES: usize = 32;
/// A configured token shorter than this is treated as malformed.
const MIN_TOKEN_BYTES: usize = 16;

/// Resolve the Agent Token: the operator override, else the persisted value,
/// else a freshly generated and persisted one.
///
/// An unreadable, malformed or loosely-permissioned persisted value is an
/// error rather than a reason to generate another: silently rotating the secret
/// would disconnect every client that holds the current one with no explanation.
pub fn resolve_agent_token(config_path: &Path, configured: &str) -> Result<SecretString> {
    let configured = configured.trim();
    if !configured.is_empty() {
        validate_token(configured, "agent_token")?;
        return Ok(SecretString::new(configured));
    }

    let path = token_path(config_path);
    match read_existing(&path)? {
        Some(token) => Ok(token),
        None => generate_and_persist(&path),
    }
}

/// Where the generated token for `config_path` lives.
pub fn token_path(config_path: &Path) -> PathBuf {
    config_path.with_extension("token")
}

fn read_existing(path: &Path) -> Result<Option<SecretString>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "cannot inspect the Agent token file {}; fix its permissions or set \
                     `agent_token` explicitly",
                    path.display()
                )
            })
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        if mode & 0o077 != 0 {
            bail!(
                "Agent token file {} is accessible to group or others (mode {:o}); fix: \
                 `chmod 600 {}` or set `agent_token` explicitly",
                path.display(),
                mode & 0o777,
                path.display()
            );
        }
    }
    let raw = fs::read_to_string(path).with_context(|| {
        format!(
            "cannot read the Agent token file {}; fix its permissions or set `agent_token` \
             explicitly",
            path.display()
        )
    })?;
    let token = raw.trim();
    validate_token(token, "Agent token file")?;
    Ok(Some(SecretString::new(token)))
}

fn generate_and_persist(path: &Path) -> Result<SecretString> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "cannot create the directory for the Agent token file {}",
                path.display()
            )
        })?;
    }
    let token = generate_token();
    #[cfg(unix)]
    let mut options = {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = OpenOptions::new();
        options.mode(0o600);
        options
    };
    #[cfg(not(unix))]
    let mut options = OpenOptions::new();
    let mut file = match options.write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            // A concurrent start won the race. Its value is the durable one.
            return match read_existing(path)? {
                Some(token) => Ok(token),
                None => bail!(
                    "Agent token file {} appeared but could not be read; fix its permissions",
                    path.display()
                ),
            };
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "cannot create the Agent token file {}; fix: set `agent_token` explicitly",
                    path.display()
                )
            })
        }
    };
    file.write_all(token.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .with_context(|| {
            format!(
                "cannot persist the Agent token to {}; fix: set `agent_token` explicitly",
                path.display()
            )
        })?;
    Ok(SecretString::new(token))
}

fn generate_token() -> String {
    let mut bytes = [0_u8; GENERATED_TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn validate_token(token: &str, source: &str) -> Result<()> {
    if token.len() < MIN_TOKEN_BYTES {
        bail!(
            "{source} is too short ({} bytes; need at least {MIN_TOKEN_BYTES}). Fix: set a \
             cryptographically random `agent_token` or remove it so one is generated",
            token.len()
        );
    }
    if token
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        bail!("{source} must not contain whitespace or control characters");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_config() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("agent-config.toml");
        fs::write(&config, "").unwrap();
        (dir, config)
    }

    #[test]
    fn an_explicit_token_wins_and_is_not_persisted() {
        let (_dir, config) = temp_config();
        let token = resolve_agent_token(&config, "operator-supplied-token-1234").unwrap();
        assert_eq!(token.as_str(), "operator-supplied-token-1234");
        assert!(!token_path(&config).exists());
    }

    #[test]
    fn a_generated_token_persists_across_restarts() {
        let (_dir, config) = temp_config();
        let first = resolve_agent_token(&config, "").unwrap();
        let second = resolve_agent_token(&config, "").unwrap();
        assert_eq!(first.as_str(), second.as_str());
        assert!(first.as_str().len() >= MIN_TOKEN_BYTES);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(token_path(&config))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn a_configured_token_is_this_agents_and_not_anothers() {
        let (_dir, config) = temp_config();
        let token = resolve_agent_token(&config, "agent-a-token-000000").unwrap();
        assert!(token.verify("agent-a-token-000000"));
        assert!(!token.verify("agent-b-token-000000"));
    }

    #[test]
    fn malformed_tokens_fail_closed() {
        let (_dir, config) = temp_config();
        assert!(resolve_agent_token(&config, "short").is_err());
        assert!(resolve_agent_token(&config, "has a space in it 123").is_err());
        assert!(resolve_agent_token(&config, "control\u{7}token-1234567").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_loosely_permissioned_token_file_fails_closed() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, config) = temp_config();
        let path = token_path(&config);
        fs::write(&path, "loose-token-file-0000\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let error = resolve_agent_token(&config, "").unwrap_err().to_string();
        assert!(error.contains("accessible to group or others"), "{error}");
    }
}
