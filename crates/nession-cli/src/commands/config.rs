//! Config CLI commands — init, show, and modify agent/server configuration.
//!
//! Agent and Server configs carry credentials — `auth_token` for a Server, and
//! since `#1013` `agent_token` for an agent's own P2P socket — so two invariants
//! hold at this boundary (#1017):
//!
//! - a secret value is never printed by default — neither by `show` nor in the
//!   confirmation `set` prints;
//! - a file holding one is private, and stays private across a rewrite.
//!
//! Both are expressed once — in [`SECRET_KEYS`] and [`write_private`] — so a
//! second credential does not mean remembering every path a value can reach.

use anyhow::{Context, Result};
use nession_agent::config::AgentConfig;
use nession_common::config::ServerConfig;
use std::fs;
use std::path::{Path, PathBuf};

/// Config target: agent or server.
pub enum ConfigTarget {
    Agent,
    Server,
}

/// Return the default config path for the given target.
pub fn default_config_path(target: &ConfigTarget) -> Result<PathBuf> {
    match target {
        ConfigTarget::Agent => nession_common::paths::agent_config_path()
            .context("failed to determine agent config path"),
        ConfigTarget::Server => nession_common::paths::server_config_path()
            .context("failed to determine server config path"),
    }
}

/// Return the human-readable label for the config target.
fn target_label(target: &ConfigTarget) -> &'static str {
    match target {
        ConfigTarget::Agent => "agent",
        ConfigTarget::Server => "server",
    }
}

/// What a secret value is replaced with in output.
const MASK: &str = "********";

/// Config keys whose values are credentials.
///
/// One list, asked by every output path: `show` redacts by walking the parsed
/// document, so a key added here is redacted wherever it appears and at any
/// depth, and `set` asks the same question before echoing a value. Adding a
/// credential is therefore one line rather than one line per command — which is
/// the property that keeps the next command from leaking it by omission.
const SECRET_KEYS: [&str; 2] = ["auth_token", "agent_token"];

fn is_secret(key: &str) -> bool {
    SECRET_KEYS.contains(&key)
}

/// Replace every secret value in `value` with [`MASK`], at any depth.
///
/// Walks the parsed document rather than the raw text on purpose: a line-based
/// mask replaces the first line of a multi-line string
/// (`auth_token = """…"""`) and leaves its continuation in the output. Parsing
/// cannot miss a value; matching text can.
///
/// An *empty* secret is left empty. There is nothing to hide, and masking it
/// would claim a credential the file does not contain — which matters for an
/// agent running in no-auth mode.
fn redact(value: &mut toml::Value) {
    match value {
        toml::Value::Table(table) => {
            for (key, entry) in table.iter_mut() {
                if is_secret(key) {
                    if !entry.as_str().unwrap_or_default().is_empty() {
                        *entry = toml::Value::String(MASK.to_string());
                    }
                } else {
                    redact(entry);
                }
            }
        }
        toml::Value::Array(items) => items.iter_mut().for_each(redact),
        _ => {}
    }
}

/// The text `show` prints for `content`: the *parsed* config, secrets masked.
///
/// Parsed rather than pattern-matched, so a secret cannot survive in a form the
/// matcher did not anticipate (see [`redact`]). Key order follows the parsed
/// map, which is not necessarily the file's — TOML is order-independent, and
/// the alternative is a redaction that can miss.
fn rendered_config(label: &str, content: &str) -> Result<String> {
    let mut parsed: toml::Value =
        toml::from_str(content).with_context(|| format!("failed to parse {label} config"))?;
    redact(&mut parsed);
    toml::to_string_pretty(&parsed).context("failed to render config")
}

/// The confirmation line `set` prints, with the value masked when it is a
/// secret: the point of `config set auth_token` is not to put the token into a
/// scrollback buffer or a log capture.
fn updated_message(label: &str, key: &str, value: &str) -> String {
    let shown = if is_secret(key) { MASK } else { value };
    format!("{label} config updated: {key} = {shown}")
}

/// Write `contents` to `path`, privately and atomically.
///
/// The staged file is **created** at 0600 rather than chmod'ed afterwards: a
/// create-then-chmod leaves the secret readable for the window in between,
/// which is exactly what this exists to prevent. `rename` then swaps it in one
/// step, so a reader sees either the old file or the new one, and a failure
/// part-way cannot leave a truncated config behind.
///
/// The rename also *reinforces* the mode on `config set`: whatever the old
/// file's permissions were, the destination becomes a fresh 0600 inode.
#[cfg(unix)]
fn write_private(path: &Path, contents: &str) -> Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    // Same directory as the destination, because `rename` is only atomic within
    // a filesystem. The pid keeps two concurrent runs from adopting one another's
    // staging file; it is not what makes the swap atomic.
    let staged = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    // A staging file left by an interrupted run must not dictate the mode it is
    // reopened with, so it is removed rather than truncated in place.
    let _ = fs::remove_file(&staged);
    if let Err(error) = stage_private(&staged, contents) {
        let _ = fs::remove_file(&staged);
        return Err(error)
            .with_context(|| format!("failed to write config to: {}", staged.display()));
    }
    fs::rename(&staged, path)
        .with_context(|| format!("failed to install config: {}", path.display()))
}

#[cfg(unix)]
fn stage_private(staged: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(staged)?;
    file.write_all(contents.as_bytes())?;
    // Before the rename, so the contents are durable before the name that
    // claims them is.
    file.sync_all()
}

/// Write `contents` to `path`.
///
/// There are no permission bits to enforce here. On Windows the file inherits
/// its directory's ACL, which this command neither sets nor inspects: the
/// private-file invariant above is a Unix one, documented as such rather than
/// claimed on a platform that cannot honour it.
#[cfg(not(unix))]
fn write_private(path: &Path, contents: &str) -> Result<()> {
    fs::write(path, contents)
        .with_context(|| format!("failed to write config to: {}", path.display()))
}

/// Initialize a default configuration file.
pub fn init(target: ConfigTarget, force: bool) -> Result<()> {
    let path = default_config_path(&target)?;
    let label = target_label(&target);

    if path.exists() && !force {
        println!(
            "{} config already exists at '{}'. Use --force to overwrite.",
            label,
            path.display()
        );
        return Ok(());
    }

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }

    let toml_str = match &target {
        ConfigTarget::Agent => {
            let config = AgentConfig::default();
            toml::to_string_pretty(&config).context("failed to serialize agent config")?
        }
        ConfigTarget::Server => {
            let config = ServerConfig::default();
            toml::to_string_pretty(&config).context("failed to serialize server config")?
        }
    };

    write_private(&path, &toml_str)?;

    println!("{} config written to '{}'", label, path.display());
    Ok(())
}

/// Show the current configuration (parsed values).
pub fn show(target: ConfigTarget) -> Result<()> {
    let path = default_config_path(&target)?;
    let label = target_label(&target);

    if !path.exists() {
        println!(
            "No {} config file found at '{}'. Run 'nession config {} init' to create one.",
            label,
            path.display(),
            label
        );
        return Ok(());
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("failed to read config: {}", path.display()))?;

    let shown = rendered_config(label, &content)?;

    println!("--- {} config ({}) ---", label, path.display());
    println!("{shown}");
    Ok(())
}

/// Set a configuration key to a new value.
pub fn set(target: ConfigTarget, key: &str, value: &str) -> Result<()> {
    let path = default_config_path(&target)?;
    let label = target_label(&target);

    if !path.exists() {
        anyhow::bail!(
            "No {} config file found at '{}'. Run 'nession config {} init' first.",
            label,
            path.display(),
            label
        );
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("failed to read config: {}", path.display()))?;

    match &target {
        ConfigTarget::Agent => {
            let mut config: AgentConfig = toml::from_str(&content)
                .with_context(|| format!("failed to parse {label} config"))?;
            set_agent_field(&mut config, key, value)?;
            let toml_str =
                toml::to_string_pretty(&config).context("failed to serialize agent config")?;
            write_private(&path, &toml_str)?;
        }
        ConfigTarget::Server => {
            let mut config: ServerConfig = toml::from_str(&content)
                .with_context(|| format!("failed to parse {label} config"))?;
            set_server_field(&mut config, key, value)?;
            let toml_str =
                toml::to_string_pretty(&config).context("failed to serialize server config")?;
            write_private(&path, &toml_str)?;
        }
    }

    println!("{}", updated_message(label, key, value));
    Ok(())
}

fn set_agent_field(config: &mut AgentConfig, key: &str, value: &str) -> Result<()> {
    match key {
        "agent_id" => config.agent_id = value.to_string(),
        "server_url" => config.server_url = value.to_string(),
        "auth_token" => config.auth_token = value.to_string(),
        "listen_address" => config.listen_address = value.to_string(),
        "tls_cert_path" => config.tls_cert_path = parse_optional(value)?,
        "tls_key_path" => config.tls_key_path = parse_optional(value)?,
        "heartbeat_interval_secs" => {
            config.heartbeat_interval_secs = parse_u64(key, value)?;
        }
        "session_poll_interval_secs" => {
            config.session_poll_interval_secs = parse_u64(key, value)?;
        }
        "advertise_address" => config.advertise_address = parse_optional(value)?,
        "connect_url" => config.connect_url = parse_optional(value)?,
        "default_working_dir" => config.default_working_dir = value.to_string(),
        "file_root" => config.file_root = parse_optional(value)?,
        _ => anyhow::bail!(
            "unknown agent config key: '{key}'. Valid keys: agent_id, server_url, auth_token, \
             listen_address, tls_cert_path, tls_key_path, heartbeat_interval_secs, \
             session_poll_interval_secs, advertise_address, connect_url, \
             default_working_dir, file_root"
        ),
    }
    Ok(())
}

fn set_server_field(config: &mut ServerConfig, key: &str, value: &str) -> Result<()> {
    match key {
        "listen_address" => config.listen_address = value.to_string(),
        "tls_cert_path" => config.tls_cert_path = value.to_string(),
        "tls_key_path" => config.tls_key_path = value.to_string(),
        "auth_token" => config.auth_token = value.to_string(),
        "heartbeat_interval_secs" => {
            config.heartbeat_interval_secs = parse_u64(key, value)?;
        }
        "heartbeat_timeout_secs" => {
            config.heartbeat_timeout_secs = parse_u64(key, value)?;
        }
        "db_path" => config.db_path = value.to_string(),
        _ => anyhow::bail!(
            "unknown server config key: '{key}'. Valid keys: listen_address, tls_cert_path, \
             tls_key_path, auth_token, heartbeat_interval_secs, heartbeat_timeout_secs, db_path"
        ),
    }
    Ok(())
}

fn parse_u64(key: &str, value: &str) -> Result<u64> {
    value
        .parse::<u64>()
        .with_context(|| format!("'{key}' must be a non-negative integer, got '{value}'"))
}

/// Parse an optional string value. Empty string or "none" clears the field.
fn parse_optional(value: &str) -> Result<Option<String>> {
    if value.is_empty() || value.eq_ignore_ascii_case("none") {
        Ok(None)
    } else {
        Ok(Some(value.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Distinctive enough that a substring check on it cannot pass by accident.
    const TOKEN: &str = "s3cret-token-3f9a";

    // These return `Result` rather than panicking: `allow-expect-in-tests` only
    // covers `#[test]` functions in this repo, not the helpers beside them.

    fn agent_with_token() -> Result<String> {
        let config = AgentConfig {
            auth_token: TOKEN.to_string(),
            ..AgentConfig::default()
        };
        Ok(toml::to_string_pretty(&config)?)
    }

    fn server_with_token() -> Result<String> {
        let config = ServerConfig {
            auth_token: TOKEN.to_string(),
            ..ServerConfig::default()
        };
        Ok(toml::to_string_pretty(&config)?)
    }

    /// The agent's token **for a Server**: `auth_token`, outbound.
    ///
    /// Named for that direction, because there is now a second agent token
    /// going the other way and this test was called
    /// `show_redacts_the_agent_token` — a name that would have gone on being
    /// true of the wrong field.
    #[test]
    fn show_redacts_the_agent_auth_token() {
        let shown =
            rendered_config("agent", &agent_with_token().expect("serialize")).expect("render");
        assert!(
            !shown.contains(TOKEN),
            "the agent's server token reached `show`: {shown}"
        );
        assert!(shown.contains(MASK), "nothing was redacted: {shown}");
    }

    /// The agent's token **for its clients**: `agent_token`, inbound.
    ///
    /// Masked because a `config show` output most often ends up pasted
    /// somewhere — a bug report, a chat — and this is the secret that opens the
    /// agent's P2P socket, which dispatches session management and the file
    /// sandbox as well as the terminal.
    #[test]
    fn show_redacts_the_agent_token() {
        let mut value: toml::Value =
            toml::from_str(&agent_with_token().expect("serialize")).expect("parse");
        value.as_table_mut().expect("a document").insert(
            "agent_token".to_string(),
            toml::Value::String(TOKEN.to_string()),
        );

        let shown = rendered_config("agent", &toml::to_string_pretty(&value).expect("serialize"))
            .expect("render");

        assert!(
            !shown.contains(TOKEN),
            "the agent's P2P token reached `show`: {shown}"
        );
        assert!(shown.contains(MASK), "nothing was redacted: {shown}");
    }

    #[test]
    fn show_redacts_the_server_token() {
        let shown =
            rendered_config("server", &server_with_token().expect("serialize")).expect("render");
        assert!(
            !shown.contains(TOKEN),
            "the server token reached `show`: {shown}"
        );
        assert!(shown.contains(MASK), "nothing was redacted: {shown}");
    }

    #[test]
    fn show_keeps_non_secret_values_visible() {
        // One instance, read twice: `AgentConfig::default()` mints a fresh
        // `agent_id` per call, so a second `default()` would compare two
        // different identities and pass or fail for the wrong reason.
        let config = AgentConfig {
            auth_token: TOKEN.to_string(),
            ..AgentConfig::default()
        };
        let shown = rendered_config(
            "agent",
            &toml::to_string_pretty(&config).expect("serialize"),
        )
        .expect("render");
        assert!(
            shown.contains(&config.server_url),
            "redaction must not hide ordinary fields: {shown}"
        );
        assert!(
            shown.contains(&config.agent_id),
            "redaction must not hide ordinary fields: {shown}"
        );
    }

    /// A mask is only claimed where a value exists.
    ///
    /// `auth_token = ""` is how no-auth mode is spelled, and masking it would
    /// report a credential the file does not contain.
    #[test]
    fn an_absent_secret_is_not_masked() {
        let config = AgentConfig {
            auth_token: String::new(),
            ..AgentConfig::default()
        };
        let shown = rendered_config(
            "agent",
            &toml::to_string_pretty(&config).expect("serialize"),
        )
        .expect("render");
        assert!(
            !shown.contains(MASK),
            "an empty token is not a secret to hide: {shown}"
        );
    }

    #[test]
    fn set_does_not_echo_the_supplied_secret() {
        let line = updated_message("agent", "auth_token", TOKEN);
        assert!(!line.contains(TOKEN), "the token was echoed: {line}");
        assert!(line.contains(MASK), "nothing was redacted: {line}");
    }

    #[test]
    fn set_still_echoes_an_ordinary_value() {
        let line = updated_message("agent", "server_url", "wss://example");
        assert!(
            line.contains("wss://example"),
            "ordinary fields must still confirm what was set: {line}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn init_writes_a_private_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("agent.toml");
        write_private(&path, "auth_token = \"x\"\n").expect("write");
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "expected 0600, got {mode:o}");
    }

    #[cfg(unix)]
    #[test]
    fn set_reinforces_a_loose_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("agent.toml");
        std::fs::write(&path, "auth_token = \"old\"\n").expect("seed");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        write_private(&path, "auth_token = \"new\"\n").expect("rewrite");
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o600,
            "a rewrite must reinforce the mode, got {mode:o}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_private_leaves_no_staging_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("agent.toml");
        write_private(&path, "x = 1\n").expect("write");
        let left: Vec<String> = std::fs::read_dir(dir.path())
            .expect("read_dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name != "agent.toml")
            .collect();
        assert!(left.is_empty(), "staging files left behind: {left:?}");
    }

    /// Goal 4: redaction must not disturb the non-secret semantics.
    #[test]
    fn redaction_preserves_the_other_fields() {
        let original = agent_with_token().expect("serialize");
        let shown = rendered_config("agent", &original).expect("render");
        let parsed: AgentConfig = toml::from_str(&shown).expect("re-parse the masked render");
        let expected: AgentConfig = toml::from_str(&original).expect("parse the original");
        assert_eq!(parsed.auth_token, MASK);
        assert_eq!(parsed.agent_id, expected.agent_id);
        assert_eq!(parsed.server_url, expected.server_url);
        assert_eq!(
            parsed.heartbeat_interval_secs,
            expected.heartbeat_interval_secs
        );
    }
}
