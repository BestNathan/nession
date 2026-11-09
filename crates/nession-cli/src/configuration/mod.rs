//! Effective daemon configuration: selection, loading, typed editing.
//!
//! One owner for the questions a `config` command and an `agent|server start`
//! both ask:
//!
//! - **Which file?** An explicit `--config` is the selected file and must be
//!   readable; only an implicit selection may fall back to its documented
//!   default. A typo therefore cannot silently start a different daemon.
//! - **What is the effective config?** File values, then the daemon
//!   overrides the CLI applies (`--server-url`/`--auth-token` for an Agent).
//!   Remote CLI targeting is a different owner ([`crate::connection`]).
//! - **What may `config set` edit?** [`AGENT_FIELDS`]/[`SERVER_FIELDS`] are the
//!   typed schema. Unknown keys and invalid types fail before the file is
//!   touched; edits preserve comments and unrelated keys because only the
//!   addressed path is rewritten.
//!
//! Secrets are never printed: `show` masks [`SECRET_KEYS`] at any depth, and
//! every write goes through [`write_private`] (0600 atomically on Unix).

use anyhow::{Context, Result};
use nession_agent::config::{AdvertiseAddress, AgentConfig, AttachMode};
use nession_common::config::ServerConfig;
use std::fs;
use std::path::{Path, PathBuf};

/// Config target: agent or server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigTarget {
    Agent,
    Server,
}

impl ConfigTarget {
    pub fn label(self) -> &'static str {
        match self {
            ConfigTarget::Agent => "agent",
            ConfigTarget::Server => "server",
        }
    }

    pub fn default_path(self) -> Result<PathBuf> {
        match self {
            ConfigTarget::Agent => nession_common::paths::agent_config_path()
                .context("failed to determine agent config path"),
            ConfigTarget::Server => nession_common::paths::server_config_path()
                .context("failed to determine server config path"),
        }
    }

    fn fields(self) -> &'static [FieldSpec] {
        match self {
            ConfigTarget::Agent => AGENT_FIELDS,
            ConfigTarget::Server => SERVER_FIELDS,
        }
    }
}

/// Which file a command operates on, and how it was chosen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigSelection {
    pub path: PathBuf,
    /// True when the user named the path with `--config`. An explicit
    /// selection fails closed; only an implicit one may use defaults.
    pub explicit: bool,
}

impl ConfigSelection {
    pub fn resolve(target: ConfigTarget, explicit: Option<String>) -> Result<Self> {
        match explicit {
            Some(path) => Ok(Self {
                path: PathBuf::from(path),
                explicit: true,
            }),
            None => Ok(Self {
                path: target.default_path()?,
                explicit: false,
            }),
        }
    }

    /// The phrase diagnostics use to identify the selection source.
    pub fn source(&self) -> &'static str {
        if self.explicit {
            "--config"
        } else {
            "the default path"
        }
    }

    fn missing_error(&self, target: ConfigTarget) -> anyhow::Error {
        anyhow::anyhow!(
            "config file '{}' selected by {} does not exist.\n\
             Fix: create it with `nession config {} init --config {}` \
             or omit --config to use that target's default path.",
            self.path.display(),
            self.source(),
            target.label(),
            self.path.display()
        )
    }
}

/// The standalone Server listen address used by `nession server start` when no
/// config file is supplied.
///
/// Deliberately distinct from [`ServerConfig::default()`] (`0.0.0.0:19090`),
/// which is the `nession-server` binary's own default: the CLI starts an
/// operator's local daemon, while the standalone binary is a deployment
/// entrypoint. Both defaults are named here/in `ServerConfig` rather than
/// conflated.
pub const CLI_SERVER_FALLBACK_LISTEN: &str = "127.0.0.1:8080";

/// The Server config `nession config server init` writes.
///
/// An initialized file is a locally managed daemon, not a deployment artifact,
/// so it must never pair an all-interface listener with a blank `auth_token`:
/// the Server treats a blank token as no-auth mode, and once the file exists
/// the no-file loopback fallback no longer applies (#2889). A blank token
/// therefore keeps the listener on [`CLI_SERVER_FALLBACK_LISTEN`]; exposing the
/// Server to another machine stays an explicit operator edit of both fields.
pub fn initialized_server_config() -> ServerConfig {
    let mut config = ServerConfig::default();
    if config.auth_token.is_empty() {
        config.listen_address = CLI_SERVER_FALLBACK_LISTEN.to_string();
    }
    config
}

/// The effective daemon configuration and where it came from.
///
/// The distinction is not diagnostic only: an implicit selection whose file
/// does not exist runs on the documented defaults, and `status` must not
/// present that absent file as the loaded source (#2869 SC-04).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Loaded<T> {
    pub config: T,
    /// True only when the selected file was actually read.
    pub from_file: bool,
}

/// Describe an effective config source for an operator-facing banner.
pub fn describe_origin(path: &Path, from_file: bool) -> String {
    if from_file {
        format!("config: {}", path.display())
    } else {
        format!("built-in defaults (no config file at '{}')", path.display())
    }
}

/// Load an Agent config from the selected file, applying CLI/env overrides.
///
/// An explicit selection that is missing or unreadable fails before startup.
/// The implicit default path may be absent; that is the documented no-config
/// mode and yields [`AgentConfig::default()`].
pub fn load_agent(
    selection: &ConfigSelection,
    server_url_override: &Option<String>,
    auth_token_override: &Option<String>,
) -> Result<Loaded<AgentConfig>> {
    let (mut config, from_file) = match fs::read_to_string(&selection.path) {
        Ok(content) => (
            toml::from_str::<AgentConfig>(&content).with_context(|| {
                format!(
                    "failed to parse agent config '{}' (selected by {})",
                    selection.path.display(),
                    selection.source()
                )
            })?,
            true,
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !selection.explicit => {
            tracing::info!(
                "No config file found at '{}', using defaults",
                selection.path.display()
            );
            (AgentConfig::default(), false)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(selection.missing_error(ConfigTarget::Agent));
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "failed to read agent config '{}' (selected by {})",
                    selection.path.display(),
                    selection.source()
                )
            });
        }
    };

    // CLI/env overrides are daemon overrides, not remote targeting.
    if let Some(url) = server_url_override {
        config.server_url = url.clone();
    }
    if let Some(token) = auth_token_override {
        config.auth_token = token.clone();
    }

    finalize_agent_identity(&mut config)?;

    Ok(Loaded { config, from_file })
}

/// Load a Server config from the selected file.
///
/// An explicit selection that is missing or unreadable fails before startup.
/// The implicit default path may be absent; the documented CLI fallback then
/// applies.
pub fn load_server(selection: &ConfigSelection) -> Result<Loaded<ServerConfig>> {
    match fs::read_to_string(&selection.path) {
        Ok(content) => {
            let config = toml::from_str::<ServerConfig>(&content).with_context(|| {
                format!(
                    "failed to parse server config '{}' (selected by {})",
                    selection.path.display(),
                    selection.source()
                )
            })?;
            Ok(Loaded {
                config,
                from_file: true,
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !selection.explicit => {
            tracing::info!(
                "No config file found at '{}', using CLI defaults",
                selection.path.display()
            );
            Ok(Loaded {
                config: ServerConfig {
                    listen_address: CLI_SERVER_FALLBACK_LISTEN.to_string(),
                    ..ServerConfig::default()
                },
                from_file: false,
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(selection.missing_error(ConfigTarget::Server))
        }
        Err(error) => Err(error).with_context(|| {
            format!(
                "failed to read server config '{}' (selected by {})",
                selection.path.display(),
                selection.source()
            )
        }),
    }
}

/// Resolve stable agent identity (config + persisted `~/.nession/agent/identity`),
/// matching `nession-agent` binary startup.
fn finalize_agent_identity(config: &mut AgentConfig) -> Result<()> {
    // An empty ID means "no explicit override": resolve the previously
    // persisted identity or mint one stable ID (#2973). Never substitute the
    // hostname, which can overwrite a legitimate persisted identity.
    let identity_path = nession_common::paths::agent_identity_path()?;
    config.agent_id = nession_agent::identity::resolve_agent_id(&config.agent_id, &identity_path)?;
    Ok(())
}

// ── The editable field schema ───────────────────────────────────────────────

/// The value shape of one editable field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    String,
    OptionalString,
    Secret,
    Bool,
    U64,
    U16NonZero,
    U8Percent,
    UsizeNonZero,
    F64Positive,
    AttachMode,
    AdvertiseAddresses,
    LogLevel,
    LogRotation,
}

/// One editable field: its dotted key and typed value shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldSpec {
    pub key: &'static str,
    pub kind: FieldKind,
}

/// Every editable `AgentConfig` field.
///
/// `logging` is edited through its three dotted leaves so the value stays
/// typed; the parent table itself is not a scalar key.
pub const AGENT_FIELDS: &[FieldSpec] = &[
    FieldSpec {
        key: "agent_id",
        kind: FieldKind::String,
    },
    FieldSpec {
        key: "display_name",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "server_url",
        kind: FieldKind::String,
    },
    FieldSpec {
        key: "auth_token",
        kind: FieldKind::Secret,
    },
    FieldSpec {
        key: "agent_token",
        kind: FieldKind::Secret,
    },
    FieldSpec {
        key: "attach_mode",
        kind: FieldKind::AttachMode,
    },
    FieldSpec {
        key: "listen_address",
        kind: FieldKind::String,
    },
    FieldSpec {
        key: "tls_cert_path",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "tls_key_path",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "heartbeat_interval_secs",
        kind: FieldKind::U64,
    },
    FieldSpec {
        key: "session_poll_interval_secs",
        kind: FieldKind::U64,
    },
    FieldSpec {
        key: "advertise_address",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "connect_url",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "advertise_addresses",
        kind: FieldKind::AdvertiseAddresses,
    },
    FieldSpec {
        key: "disable_address_autodetect",
        kind: FieldKind::Bool,
    },
    FieldSpec {
        key: "default_working_dir",
        kind: FieldKind::String,
    },
    FieldSpec {
        key: "file_root",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "tmux_socket_path",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "logging.level",
        kind: FieldKind::LogLevel,
    },
    FieldSpec {
        key: "logging.rotation",
        kind: FieldKind::LogRotation,
    },
    FieldSpec {
        key: "logging.retention_days",
        kind: FieldKind::U64,
    },
    FieldSpec {
        key: "memory_threshold_percent",
        kind: FieldKind::U8Percent,
    },
    FieldSpec {
        key: "terminal_cols",
        kind: FieldKind::U16NonZero,
    },
    FieldSpec {
        key: "sandbox.enabled",
        kind: FieldKind::Bool,
    },
    FieldSpec {
        key: "sandbox.bubblewrap_path",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "sandbox.sandbox_exec_path",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "sandbox.cgroup_root",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "sandbox.state_dir",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "sandbox.bridge_executable",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "sandbox.launch_timeout_secs",
        kind: FieldKind::U64,
    },
    FieldSpec {
        key: "mcp.enabled",
        kind: FieldKind::Bool,
    },
    FieldSpec {
        key: "mcp.path",
        kind: FieldKind::String,
    },
    FieldSpec {
        key: "mcp.listen_address",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "mcp.auth_token",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "mcp.tls_cert_path",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "mcp.tls_key_path",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "mcp.tool_timeout_secs",
        kind: FieldKind::U64,
    },
    FieldSpec {
        key: "mcp.max_concurrent_calls",
        kind: FieldKind::UsizeNonZero,
    },
];

/// Every editable `ServerConfig` field.
pub const SERVER_FIELDS: &[FieldSpec] = &[
    FieldSpec {
        key: "listen_address",
        kind: FieldKind::String,
    },
    FieldSpec {
        key: "tls_cert_path",
        kind: FieldKind::String,
    },
    FieldSpec {
        key: "tls_key_path",
        kind: FieldKind::String,
    },
    FieldSpec {
        key: "auth_token",
        kind: FieldKind::Secret,
    },
    FieldSpec {
        key: "heartbeat_interval_secs",
        kind: FieldKind::U64,
    },
    FieldSpec {
        key: "heartbeat_timeout_secs",
        kind: FieldKind::U64,
    },
    FieldSpec {
        key: "db_path",
        kind: FieldKind::String,
    },
    FieldSpec {
        key: "terminal_stall_grace_secs",
        kind: FieldKind::U64,
    },
    FieldSpec {
        key: "query_concurrency_per_connection",
        kind: FieldKind::UsizeNonZero,
    },
    FieldSpec {
        key: "p2p_token_expiry_secs",
        kind: FieldKind::U64,
    },
    FieldSpec {
        key: "terminal_cols",
        kind: FieldKind::U16NonZero,
    },
    FieldSpec {
        key: "terminal_web_font_size",
        kind: FieldKind::F64Positive,
    },
    FieldSpec {
        key: "logging.level",
        kind: FieldKind::LogLevel,
    },
    FieldSpec {
        key: "logging.rotation",
        kind: FieldKind::LogRotation,
    },
    FieldSpec {
        key: "logging.retention_days",
        kind: FieldKind::U64,
    },
    FieldSpec {
        key: "mcp.enabled",
        kind: FieldKind::Bool,
    },
    FieldSpec {
        key: "mcp.path",
        kind: FieldKind::String,
    },
    FieldSpec {
        key: "mcp.listen_address",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "mcp.auth_token",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "mcp.tls_cert_path",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "mcp.tls_key_path",
        kind: FieldKind::OptionalString,
    },
    FieldSpec {
        key: "mcp.tool_timeout_secs",
        kind: FieldKind::U64,
    },
    FieldSpec {
        key: "mcp.max_concurrent_calls",
        kind: FieldKind::UsizeNonZero,
    },
];

pub fn field_specs(target: ConfigTarget) -> &'static [FieldSpec] {
    target.fields()
}

/// The valid-key list quoted by an unknown-key error.
pub fn valid_keys(target: ConfigTarget) -> String {
    target
        .fields()
        .iter()
        .map(|field| field.key)
        .collect::<Vec<_>>()
        .join(", ")
}

// ── Comments / unknown data preservation and typed editing ──────────────────

/// Write `contents` to `path`, privately and atomically.
///
/// The staged file is **created** at 0600 rather than chmod'ed afterwards: a
/// create-then-chmod leaves the secret readable for the window in between.
/// `rename` then swaps it in one step, so a reader sees either the old file or
/// the new one, and a failure part-way cannot leave a truncated config behind.
#[cfg(unix)]
fn write_private(path: &Path, contents: &str) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let staged = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let _ = fs::remove_file(&staged);
    let write = || -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&staged)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()
    };
    if let Err(error) = write() {
        let _ = fs::remove_file(&staged);
        return Err(error)
            .with_context(|| format!("failed to write config to: {}", staged.display()));
    }
    fs::rename(&staged, path)
        .with_context(|| format!("failed to install config: {}", path.display()))
}

/// There are no permission bits to enforce here. On Windows the file inherits
/// its directory's ACL, which this command neither sets nor inspects: the
/// private-file invariant is a Unix one, documented as such rather than
/// claimed on a platform that cannot honour it.
#[cfg(not(unix))]
fn write_private(path: &Path, contents: &str) -> Result<()> {
    fs::write(path, contents)
        .with_context(|| format!("failed to write config to: {}", path.display()))
}

/// Config keys whose values are credentials, at any depth.
const SECRET_KEYS: [&str; 2] = ["auth_token", "agent_token"];

fn is_secret(key: &str) -> bool {
    SECRET_KEYS.contains(&key)
}

/// What a secret value is replaced with in output.
const MASK: &str = "********";

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

/// The text `show` prints: the parsed config, secrets masked.
pub fn rendered_config(label: &str, content: &str) -> Result<String> {
    let mut parsed: toml::Value =
        toml::from_str(content).with_context(|| format!("failed to parse {label} config"))?;
    redact(&mut parsed);
    toml::to_string_pretty(&parsed).context("failed to render config")
}

/// The confirmation line `set` prints, with the value masked for a secret.
pub fn updated_message(label: &str, key: &str, value: &str) -> String {
    let shown = if key.rsplit('.').next().is_some_and(is_secret) {
        MASK
    } else {
        value
    };
    format!("{label} config updated: {key} = {shown}")
}

/// The header written above a generated Server config.
///
/// The file is the operator's first contact with the initialized defaults, so
/// it states the local no-auth mode and the explicit remote opt-in where it
/// will be read. `config set` edits through `toml_edit`, so the header
/// survives later edits.
const SERVER_INIT_HEADER: &str = "\
# Nession Server configuration.
#
# This generated default listens on loopback with no auth_token: local
# no-auth mode. Before changing listen_address to an address other machines
# can reach, set a credential too (add --config when this file is not the
# default):
#   nession config server set auth_token <token>
";

/// Create the selected config file from the target's typed defaults.
pub fn init(target: ConfigTarget, selection: &ConfigSelection, force: bool) -> Result<()> {
    let label = target.label();
    if selection.path.exists() && !force {
        println!(
            "{} config already exists at '{}'. Use --force to overwrite.",
            label,
            selection.path.display()
        );
        return Ok(());
    }

    if let Some(parent) = selection.path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }

    let toml_str = match target {
        ConfigTarget::Agent => toml::to_string_pretty(&AgentConfig::default())
            .context("failed to serialize agent config")?,
        ConfigTarget::Server => {
            let config = initialized_server_config();
            let rendered =
                toml::to_string_pretty(&config).context("failed to serialize server config")?;
            if config.auth_token.is_empty() {
                format!("{SERVER_INIT_HEADER}{rendered}")
            } else {
                rendered
            }
        }
    };

    write_private(&selection.path, &toml_str)?;

    println!("{} config written to '{}'", label, selection.path.display());
    if target == ConfigTarget::Server {
        let config = initialized_server_config();
        if config.auth_token.is_empty() {
            println!(
                "Server listens on '{}' with no auth_token (local no-auth mode); \
                 remote access requires setting auth_token and listen_address explicitly.",
                config.listen_address
            );
        }
    }
    Ok(())
}

/// Show the selected config file (secrets masked).
pub fn show(target: ConfigTarget, selection: &ConfigSelection) -> Result<()> {
    let label = target.label();
    if !selection.path.exists() {
        if selection.explicit {
            return Err(selection.missing_error(target));
        }
        println!(
            "No {} config file found at '{}'. Run 'nession config {} init' to create one.",
            label,
            selection.path.display(),
            label
        );
        return Ok(());
    }

    let content = fs::read_to_string(&selection.path)
        .with_context(|| format!("failed to read config: {}", selection.path.display()))?;
    let shown = rendered_config(label, &content)?;

    println!("--- {} config ({}) ---", label, selection.path.display());
    println!("{shown}");
    Ok(())
}

/// Set one typed key in the selected config file.
///
/// The edit is made on a `toml_edit` document, so comments and unrelated keys
/// survive. The candidate document is then deserialized into the real
/// `AgentConfig`/`ServerConfig`; an invalid type or a value the contract
/// rejects cannot reach the file.
pub fn set(
    target: ConfigTarget,
    selection: &ConfigSelection,
    key: &str,
    value: &str,
) -> Result<()> {
    let label = target.label();
    if !selection.path.exists() {
        if selection.explicit {
            return Err(selection.missing_error(target));
        }
        anyhow::bail!(
            "No {} config file found at '{}'. Run 'nession config {} init' first.",
            label,
            selection.path.display(),
            label
        );
    }

    let content = fs::read_to_string(&selection.path)
        .with_context(|| format!("failed to read config: {}", selection.path.display()))?;
    let mut document: toml_edit::DocumentMut = content
        .parse()
        .with_context(|| format!("failed to parse {label} config"))?;

    let spec = target
        .fields()
        .iter()
        .find(|field| field.key == key)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "unknown {label} config key: '{key}'. Valid keys: {}",
                valid_keys(target)
            )
        })?;

    apply_field(&mut document, spec, value)
        .with_context(|| format!("invalid value for '{key}'"))?;

    let rendered = document.to_string();
    match target {
        ConfigTarget::Agent => {
            let candidate: AgentConfig = toml::from_str(&rendered)
                .with_context(|| format!("'{key}' would make the {label} config invalid"))?;
            // The runtime's own validation is the contract: a value it would
            // reject must not reach the file just because it deserializes.
            candidate
                .validate()
                .with_context(|| format!("'{key}' would make the {label} config invalid"))?;
        }
        ConfigTarget::Server => {
            let candidate: ServerConfig = toml::from_str(&rendered)
                .with_context(|| format!("'{key}' would make the {label} config invalid"))?;
            candidate
                .validate()
                .with_context(|| format!("'{key}' would make the {label} config invalid"))?;
        }
    }

    write_private(&selection.path, &rendered)?;
    println!("{}", updated_message(label, key, value));
    Ok(())
}

fn apply_field(document: &mut toml_edit::DocumentMut, spec: &FieldSpec, value: &str) -> Result<()> {
    if matches!(spec.kind, FieldKind::OptionalString) && is_clear(value) {
        remove_path(document, spec.key);
        return Ok(());
    }

    let item = match spec.kind {
        FieldKind::String | FieldKind::Secret | FieldKind::LogLevel | FieldKind::LogRotation => {
            let value = match spec.kind {
                FieldKind::LogLevel => validate_log_level(value)?.to_string(),
                FieldKind::LogRotation => validate_log_rotation(value)?.to_string(),
                _ => value.to_string(),
            };
            toml_edit::value(value)
        }
        FieldKind::OptionalString => toml_edit::value(value.to_string()),
        FieldKind::Bool => toml_edit::value(parse_bool(value)?),
        FieldKind::U64 => toml_edit::value(
            i64::try_from(parse_u64(value)?).context("value exceeds TOML's integer range")?,
        ),
        FieldKind::U16NonZero => {
            let parsed = value
                .parse::<u16>()
                .with_context(|| format!("expected a positive integer, got '{value}'"))?;
            if parsed == 0 {
                anyhow::bail!("expected a positive integer, got 0");
            }
            toml_edit::value(i64::from(parsed))
        }
        FieldKind::U8Percent => {
            let parsed = value
                .parse::<u8>()
                .with_context(|| format!("expected an integer 0-100, got '{value}'"))?;
            if parsed > 100 {
                anyhow::bail!("expected an integer 0-100, got {parsed}");
            }
            toml_edit::value(i64::from(parsed))
        }
        FieldKind::UsizeNonZero => {
            let parsed = value
                .parse::<usize>()
                .with_context(|| format!("expected a positive integer, got '{value}'"))?;
            if parsed == 0 {
                anyhow::bail!("expected a positive integer, got 0");
            }
            toml_edit::value(parsed as i64)
        }
        FieldKind::F64Positive => {
            let parsed = value
                .parse::<f64>()
                .with_context(|| format!("expected a positive number, got '{value}'"))?;
            if !parsed.is_finite() || parsed <= 0.0 {
                anyhow::bail!("expected a positive number, got '{value}'");
            }
            toml_edit::value(parsed)
        }
        FieldKind::AttachMode => {
            let parsed = match value.to_ascii_lowercase().as_str() {
                "plain" => AttachMode::Plain,
                "control" => AttachMode::Control,
                other => anyhow::bail!("expected 'plain' or 'control', got '{other}'"),
            };
            toml_edit::value(match parsed {
                AttachMode::Plain => "plain",
                AttachMode::Control => "control",
            })
        }
        FieldKind::AdvertiseAddresses => advertise_addresses_item(value)?,
    };

    set_path(document, spec.key, item)
}

fn is_clear(value: &str) -> bool {
    value.is_empty() || value.eq_ignore_ascii_case("none")
}

fn parse_bool(value: &str) -> Result<bool> {
    match value.to_ascii_lowercase().as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        other => anyhow::bail!("expected 'true' or 'false', got '{other}'"),
    }
}

fn parse_u64(value: &str) -> Result<u64> {
    value
        .parse::<u64>()
        .with_context(|| format!("expected a non-negative integer, got '{value}'"))
}

fn validate_log_level(value: &str) -> Result<&str> {
    match value.to_ascii_lowercase().as_str() {
        "trace" | "debug" | "info" | "warn" | "error" => Ok(value),
        other => anyhow::bail!("expected one of trace, debug, info, warn, error, got '{other}'"),
    }
}

fn validate_log_rotation(value: &str) -> Result<&str> {
    match value.to_ascii_lowercase().as_str() {
        "daily" | "hourly" | "never" => Ok(value),
        other => anyhow::bail!("expected one of daily, hourly, never, got '{other}'"),
    }
}

/// A JSON array of `{url,label,network_type,priority}` objects, converted to a
/// typed TOML array. JSON is used because a one-line CLI value cannot express
/// a TOML array of tables; the schema still validates every field through
/// `AdvertiseAddress`'s own deserializer.
fn advertise_addresses_item(value: &str) -> Result<toml_edit::Item> {
    if is_clear(value) {
        anyhow::bail!("use '[]' to clear advertise_addresses");
    }
    let addresses: Vec<AdvertiseAddress> = serde_json::from_str(value).with_context(|| {
        "expected a JSON array of {\"url\",\"label\",\"network_type\",\"priority\"} objects"
    })?;
    let mut array = toml_edit::Array::new();
    for address in addresses {
        let mut table = toml_edit::InlineTable::new();
        table.insert("url", toml_edit::Value::from(address.url));
        if let Some(label) = address.label {
            table.insert("label", toml_edit::Value::from(label));
        }
        table.insert(
            "network_type",
            toml_edit::Value::from(address.network_type.as_str()),
        );
        table.insert(
            "priority",
            toml_edit::Value::from(i64::from(address.priority)),
        );
        array.push(toml_edit::Value::InlineTable(table));
    }
    Ok(toml_edit::Item::Value(toml_edit::Value::Array(array)))
}

/// Set a dotted key, creating intermediate tables.
fn set_path(document: &mut toml_edit::DocumentMut, key: &str, item: toml_edit::Item) -> Result<()> {
    let parts: Vec<&str> = key.split('.').collect();
    let (leaf, parents) = parts
        .split_last()
        .ok_or_else(|| anyhow::anyhow!("empty config key"))?;
    let mut table = document.as_table_mut();
    for part in parents {
        let entry = table
            .entry(part)
            .or_insert_with(|| toml_edit::Item::Table(toml_edit::Table::new()));
        table = entry.as_table_mut().ok_or_else(|| {
            anyhow::anyhow!("'{part}' is not a config table; cannot set a nested key")
        })?;
    }
    table.insert(leaf, item);
    Ok(())
}

/// Remove a dotted key, leaving anything else in its parent intact.
fn remove_path(document: &mut toml_edit::DocumentMut, key: &str) {
    let parts: Vec<&str> = key.split('.').collect();
    let Some((leaf, parents)) = parts.split_last() else {
        return;
    };
    let mut table = document.as_table_mut();
    for part in parents {
        let Some(entry) = table.get_mut(part) else {
            return;
        };
        let Some(next) = entry.as_table_mut() else {
            return;
        };
        table = next;
    }
    table.remove(leaf);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_selection(
        _target: ConfigTarget,
        contents: &str,
    ) -> (tempfile::TempDir, ConfigSelection) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.toml");
        let mut file = fs::File::create(&path).expect("create");
        file.write_all(contents.as_bytes()).expect("write");
        (
            dir,
            ConfigSelection {
                path,
                explicit: true,
            },
        )
    }

    /// The schema is the contract: a new field on either typed config must be
    /// added here, or this test fails.
    #[test]
    fn every_serialized_field_has_a_schema_entry() {
        let agent = toml::Value::try_from(AgentConfig::default()).expect("agent defaults");
        let agent_table = agent.as_table().expect("agent table");
        for key in agent_table
            .keys()
            .filter(|key| *key != "logging" && *key != "sandbox" && *key != "mcp")
        {
            assert!(
                AGENT_FIELDS.iter().any(|field| field.key == key),
                "AgentConfig field '{key}' is missing from AGENT_FIELDS"
            );
        }
        let agent_sandbox = agent_table
            .get("sandbox")
            .and_then(toml::Value::as_table)
            .expect("agent sandbox table");
        for key in agent_sandbox.keys() {
            let dotted = format!("sandbox.{key}");
            assert!(
                AGENT_FIELDS.iter().any(|field| field.key == dotted),
                "AgentConfig field '{dotted}' is missing from AGENT_FIELDS"
            );
        }
        let agent_mcp = agent_table
            .get("mcp")
            .and_then(toml::Value::as_table)
            .expect("agent mcp table");
        for key in agent_mcp.keys() {
            let dotted = format!("mcp.{key}");
            assert!(
                AGENT_FIELDS.iter().any(|field| field.key == dotted),
                "AgentConfig field '{dotted}' is missing from AGENT_FIELDS"
            );
        }
        let agent_logging = agent_table
            .get("logging")
            .and_then(toml::Value::as_table)
            .expect("agent logging table");
        for key in agent_logging.keys() {
            let dotted = format!("logging.{key}");
            assert!(
                AGENT_FIELDS.iter().any(|field| field.key == dotted),
                "AgentConfig field '{dotted}' is missing from AGENT_FIELDS"
            );
        }

        let server = toml::Value::try_from(ServerConfig::default()).expect("server defaults");
        let server_table = server.as_table().expect("server table");
        for key in server_table
            .keys()
            .filter(|key| *key != "logging" && *key != "mcp")
        {
            assert!(
                SERVER_FIELDS.iter().any(|field| field.key == key),
                "ServerConfig field '{key}' is missing from SERVER_FIELDS"
            );
        }
        let server_mcp = server_table
            .get("mcp")
            .and_then(toml::Value::as_table)
            .expect("server mcp table");
        for key in server_mcp.keys() {
            let dotted = format!("mcp.{key}");
            assert!(
                SERVER_FIELDS.iter().any(|field| field.key == dotted),
                "ServerConfig field '{dotted}' is missing from SERVER_FIELDS"
            );
        }
        let server_logging = server_table
            .get("logging")
            .and_then(toml::Value::as_table)
            .expect("server logging table");
        for key in server_logging.keys() {
            let dotted = format!("logging.{key}");
            assert!(
                SERVER_FIELDS.iter().any(|field| field.key == dotted),
                "ServerConfig field '{dotted}' is missing from SERVER_FIELDS"
            );
        }
    }

    #[test]
    fn an_explicit_missing_config_fails_closed() {
        let selection = ConfigSelection {
            path: PathBuf::from("/definitely/missing/agent-config.toml"),
            explicit: true,
        };
        let error = load_agent(&selection, &None, &None).expect_err("must fail");
        let message = format!("{error:#}");
        assert!(message.contains("does not exist"), "{message}");
        assert!(message.contains("config agent init --config"), "{message}");
    }

    #[test]
    fn an_implicit_missing_config_uses_the_documented_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let selection = ConfigSelection {
            path: dir.path().join("agent-config.toml"),
            explicit: false,
        };
        let loaded = load_agent(&selection, &None, &None).expect("defaults");
        assert!(
            !loaded.from_file,
            "no file existed, so defaults are in effect"
        );
        assert_eq!(loaded.config.server_url, AgentConfig::default().server_url);
    }

    #[test]
    fn an_explicit_server_missing_config_fails_closed() {
        let selection = ConfigSelection {
            path: PathBuf::from("/definitely/missing/server-config.toml"),
            explicit: true,
        };
        let error = load_server(&selection).expect_err("must fail");
        assert!(format!("{error:#}").contains("does not exist"));
    }

    #[test]
    fn the_implicit_server_default_is_the_named_cli_fallback() {
        let dir = tempfile::tempdir().expect("tempdir");
        let selection = ConfigSelection {
            path: dir.path().join("server-config.toml"),
            explicit: false,
        };
        let loaded = load_server(&selection).expect("defaults");
        assert!(!loaded.from_file);
        assert_eq!(loaded.config.listen_address, CLI_SERVER_FALLBACK_LISTEN);
    }

    /// A file that *does* exist is reported as the loaded source even when it
    /// was selected implicitly, so provenance follows the actual read.
    #[test]
    fn an_existing_implicit_config_is_reported_as_loaded() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("server-config.toml");
        fs::write(
            &path,
            "listen_address = \"127.0.0.1:19090\"\n\
             tls_cert_path = \"\"\n\
             tls_key_path = \"\"\n\
             auth_token = \"\"\n",
        )
        .expect("seed");
        let selection = ConfigSelection {
            path,
            explicit: false,
        };
        let loaded = load_server(&selection).expect("load");
        assert!(loaded.from_file);
        assert_eq!(loaded.config.listen_address, "127.0.0.1:19090");
    }

    /// `init` writes a typed Server config whose blank token is paired only
    /// with a loopback listener (#2889 SC-01).
    fn assert_safe_server_pairing(path: &Path) {
        let content = fs::read_to_string(path).expect("read server config");
        let config: ServerConfig = toml::from_str(&content).expect("typed server config");
        assert!(
            config.auth_token.is_empty(),
            "initialization must not invent a credential: {}",
            config.auth_token
        );
        let listen: std::net::SocketAddr = config
            .listen_address
            .parse()
            .expect("the initialized listener must be host:port");
        assert!(
            listen.ip().is_loopback(),
            "a blank auth_token must pair with a loopback listener, got {}",
            config.listen_address
        );
        assert_ne!(
            (config.listen_address.as_str(), config.auth_token.as_str()),
            ("0.0.0.0:19090", ""),
            "the #2889 unsafe pairing must never be generated"
        );
    }

    #[test]
    fn the_initialized_server_config_pairs_a_blank_token_with_loopback() {
        let config = initialized_server_config();
        assert!(config.auth_token.is_empty());
        assert_eq!(config.listen_address, CLI_SERVER_FALLBACK_LISTEN);
        assert!(config
            .listen_address
            .parse::<std::net::SocketAddr>()
            .expect("host:port")
            .ip()
            .is_loopback());
    }

    #[test]
    fn init_writes_the_safe_server_profile_including_a_force_rewrite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let selection = ConfigSelection {
            path: dir.path().join("server.toml"),
            explicit: true,
        };

        init(ConfigTarget::Server, &selection, false).expect("init");
        assert_safe_server_pairing(&selection.path);

        // An operator-authored network config must not survive a `--force`
        // rewrite that would reintroduce the unsafe generated pairing.
        fs::write(
            &selection.path,
            "listen_address = \"0.0.0.0:19090\"\n\
             tls_cert_path = \"\"\n\
             tls_key_path = \"\"\n\
             auth_token = \"operator-secret\"\n",
        )
        .expect("seed operator config");
        init(ConfigTarget::Server, &selection, true).expect("force init");
        assert_safe_server_pairing(&selection.path);
    }

    /// An operator-authored remote/authenticated config is loaded exactly as
    /// written; loading never rewrites the file (#2889 SC-02).
    #[test]
    fn an_operator_authored_remote_server_config_loads_unchanged() {
        let (_dir, selection) = temp_selection(
            ConfigTarget::Server,
            "listen_address = \"0.0.0.0:19090\"\n\
             tls_cert_path = \"\"\n\
             tls_key_path = \"\"\n\
             auth_token = \"operator-secret\"\n",
        );
        let before = fs::read_to_string(&selection.path).expect("read before");
        let loaded = load_server(&selection).expect("load");
        assert!(loaded.from_file);
        assert_eq!(loaded.config.listen_address, "0.0.0.0:19090");
        assert_eq!(loaded.config.auth_token, "operator-secret");
        assert_eq!(
            before,
            fs::read_to_string(&selection.path).expect("read after"),
            "loading a config must not rewrite it"
        );
    }

    /// Deliberate local no-auth mode remains supported (#2889 SC-02).
    #[test]
    fn an_operator_authored_loopback_no_auth_server_config_is_supported() {
        let (_dir, selection) = temp_selection(
            ConfigTarget::Server,
            "listen_address = \"127.0.0.1:19090\"\n\
             tls_cert_path = \"\"\n\
             tls_key_path = \"\"\n\
             auth_token = \"\"\n",
        );
        let loaded = load_server(&selection).expect("load");
        assert_eq!(loaded.config.listen_address, "127.0.0.1:19090");
        assert!(loaded.config.auth_token.is_empty());
    }

    /// #2869 SC-02: the editor defers to the runtime validators. A value the
    /// daemon would refuse must be refused here, before the file is written.
    #[test]
    fn set_rejects_values_the_runtime_would_reject() {
        let invalid = [
            (ConfigTarget::Agent, "terminal_cols", "19"),
            (ConfigTarget::Agent, "terminal_cols", "401"),
            (ConfigTarget::Server, "terminal_cols", "19"),
            (ConfigTarget::Server, "terminal_cols", "401"),
            (ConfigTarget::Server, "terminal_web_font_size", "5.9"),
            (ConfigTarget::Server, "terminal_web_font_size", "32.1"),
            (ConfigTarget::Server, "terminal_web_font_size", "0"),
        ];
        for (target, key, value) in invalid {
            let defaults = match target {
                ConfigTarget::Agent => {
                    toml::to_string_pretty(&AgentConfig::default()).expect("serialize")
                }
                ConfigTarget::Server => {
                    toml::to_string_pretty(&ServerConfig::default()).expect("serialize")
                }
            };
            let (_dir, selection) = temp_selection(target, &defaults);
            let before = fs::read_to_string(&selection.path).expect("read before");

            let error = set(target, &selection, key, value)
                .expect_err("a runtime-invalid value must be refused");
            let message = format!("{error:#}");
            assert!(
                (message.contains("would make the") && message.contains("config invalid"))
                    || message.contains("invalid value for"),
                "{key}={value}: {message}"
            );
            assert_eq!(
                before,
                fs::read_to_string(&selection.path).expect("read after"),
                "{key}={value} must not change the file"
            );
        }
    }

    /// The accepted boundaries stay accepted; the fix must not narrow them.
    #[test]
    fn set_accepts_the_runtime_boundaries() {
        let valid = [
            (ConfigTarget::Agent, "terminal_cols", "20", false),
            (ConfigTarget::Agent, "terminal_cols", "400", false),
            (ConfigTarget::Server, "terminal_cols", "20", true),
            (ConfigTarget::Server, "terminal_cols", "400", true),
            (ConfigTarget::Server, "terminal_web_font_size", "6", true),
            (ConfigTarget::Server, "terminal_web_font_size", "32", true),
        ];
        for (target, key, value, server) in valid {
            let defaults = if server {
                toml::to_string_pretty(&ServerConfig::default()).expect("serialize")
            } else {
                toml::to_string_pretty(&AgentConfig::default()).expect("serialize")
            };
            let (_dir, selection) = temp_selection(target, &defaults);
            set(target, &selection, key, value)
                .unwrap_or_else(|error| panic!("{key}={value} must be accepted: {error:#}"));
        }
    }

    #[test]
    fn setting_every_agent_field_round_trips_into_the_typed_config() {
        let (dir, selection) = temp_selection(
            ConfigTarget::Agent,
            &toml::to_string_pretty(&AgentConfig::default()).expect("serialize"),
        );
        let values = [
            ("agent_id", "my-agent"),
            ("display_name", "My Agent"),
            ("server_url", "ws://example:8443"),
            ("auth_token", "server-secret"),
            ("agent_token", "p2p-secret"),
            ("attach_mode", "plain"),
            ("listen_address", "127.0.0.1:0"),
            ("tls_cert_path", "/tmp/cert.pem"),
            ("tls_key_path", "/tmp/key.pem"),
            ("heartbeat_interval_secs", "7"),
            ("session_poll_interval_secs", "8"),
            ("advertise_address", "10.0.0.5"),
            ("connect_url", "wss://example/ws"),
            (
                "advertise_addresses",
                r#"[{"url":"wss://tunnel.example/ws","label":"tunnel","network_type":"tunnel","priority":3}]"#,
            ),
            ("disable_address_autodetect", "true"),
            ("default_working_dir", "/tmp/work"),
            ("file_root", "/tmp/root"),
            ("tmux_socket_path", "/tmp/nession-tmux.sock"),
            ("logging.level", "debug"),
            ("logging.rotation", "hourly"),
            ("logging.retention_days", "3"),
            ("memory_threshold_percent", "80"),
            ("terminal_cols", "200"),
        ];
        for (key, value) in values {
            set(ConfigTarget::Agent, &selection, key, value)
                .unwrap_or_else(|error| panic!("set {key}: {error:#}"));
        }
        let content = fs::read_to_string(&selection.path).expect("read");
        let config: AgentConfig = toml::from_str(&content).expect("parse typed config");
        assert_eq!(config.agent_id, "my-agent");
        assert_eq!(config.display_name.as_deref(), Some("My Agent"));
        assert_eq!(config.server_url, "ws://example:8443");
        assert_eq!(config.auth_token, "server-secret");
        assert_eq!(config.agent_token, "p2p-secret");
        assert_eq!(format!("{:?}", config.attach_mode), "Plain");
        assert_eq!(config.listen_address, "127.0.0.1:0");
        assert_eq!(config.tls_cert_path.as_deref(), Some("/tmp/cert.pem"));
        assert_eq!(config.tls_key_path.as_deref(), Some("/tmp/key.pem"));
        assert_eq!(config.heartbeat_interval_secs, 7);
        assert_eq!(config.session_poll_interval_secs, 8);
        assert_eq!(config.advertise_address.as_deref(), Some("10.0.0.5"));
        assert_eq!(config.connect_url.as_deref(), Some("wss://example/ws"));
        assert_eq!(config.advertise_addresses.len(), 1);
        assert_eq!(config.advertise_addresses[0].url, "wss://tunnel.example/ws");
        assert_eq!(config.advertise_addresses[0].priority, 3);
        assert!(config.disable_address_autodetect);
        assert_eq!(config.default_working_dir, "/tmp/work");
        assert_eq!(config.file_root.as_deref(), Some("/tmp/root"));
        assert_eq!(
            config.tmux_socket_path.as_deref(),
            Some("/tmp/nession-tmux.sock")
        );
        assert_eq!(config.logging.level, "debug");
        assert_eq!(config.logging.rotation, "hourly");
        assert_eq!(config.logging.retention_days, 3);
        assert_eq!(config.memory_threshold_percent, 80);
        assert_eq!(config.terminal_cols, 200);
        assert!(dir.path().exists());
    }

    #[test]
    fn setting_every_server_field_round_trips_into_the_typed_config() {
        let (_dir, selection) = temp_selection(
            ConfigTarget::Server,
            &toml::to_string_pretty(&ServerConfig::default()).expect("serialize"),
        );
        let values = [
            ("listen_address", "127.0.0.1:19090"),
            ("tls_cert_path", "/tmp/cert.pem"),
            ("tls_key_path", "/tmp/key.pem"),
            ("auth_token", "server-secret"),
            ("heartbeat_interval_secs", "11"),
            ("heartbeat_timeout_secs", "22"),
            ("db_path", "/tmp/server.db"),
            ("terminal_stall_grace_secs", "33"),
            ("query_concurrency_per_connection", "4"),
            ("p2p_token_expiry_secs", "44"),
            ("terminal_cols", "120"),
            ("terminal_web_font_size", "13.5"),
            ("logging.level", "warn"),
            ("logging.rotation", "never"),
            ("logging.retention_days", "0"),
        ];
        for (key, value) in values {
            set(ConfigTarget::Server, &selection, key, value)
                .unwrap_or_else(|error| panic!("set {key}: {error:#}"));
        }
        let content = fs::read_to_string(&selection.path).expect("read");
        let config: ServerConfig = toml::from_str(&content).expect("parse typed config");
        assert_eq!(config.listen_address, "127.0.0.1:19090");
        assert_eq!(config.tls_cert_path, "/tmp/cert.pem");
        assert_eq!(config.tls_key_path, "/tmp/key.pem");
        assert_eq!(config.auth_token, "server-secret");
        assert_eq!(config.heartbeat_interval_secs, 11);
        assert_eq!(config.heartbeat_timeout_secs, 22);
        assert_eq!(config.db_path, "/tmp/server.db");
        assert_eq!(config.terminal_stall_grace_secs, 33);
        assert_eq!(config.query_concurrency_per_connection, 4);
        assert_eq!(config.p2p_token_expiry_secs, 44);
        assert_eq!(config.terminal_cols, 120);
        assert_eq!(config.terminal_web_font_size, 13.5);
        assert_eq!(config.logging.level, "warn");
        assert_eq!(config.logging.rotation, "never");
        assert_eq!(config.logging.retention_days, 0);
    }

    #[test]
    fn unknown_keys_and_invalid_types_do_not_mutate_the_file() {
        let (_dir, selection) = temp_selection(
            ConfigTarget::Agent,
            &toml::to_string_pretty(&AgentConfig::default()).expect("serialize"),
        );
        let before = fs::read_to_string(&selection.path).expect("read");

        let unknown = set(ConfigTarget::Agent, &selection, "not_a_field", "x")
            .expect_err("unknown key must be rejected");
        assert!(format!("{unknown:#}").contains("unknown agent config key"));

        let invalid = set(
            ConfigTarget::Agent,
            &selection,
            "heartbeat_interval_secs",
            "seven",
        )
        .expect_err("invalid type must be rejected");
        assert!(format!("{invalid:#}").contains("non-negative integer"));

        let after = fs::read_to_string(&selection.path).expect("read");
        assert_eq!(before, after, "a rejected set must not write the file");
    }

    #[test]
    fn set_preserves_comments_and_unrelated_keys() {
        let defaults =
            toml::to_string_pretty(&AgentConfig::default()).expect("serialize agent defaults");
        let seed = format!("# operator note\n{defaults}# keep me\n[extension]\nflag = true\n");
        let (_dir, selection) = temp_selection(ConfigTarget::Agent, &seed);
        set(ConfigTarget::Agent, &selection, "logging.level", "debug").expect("set");
        let after = fs::read_to_string(&selection.path).expect("read");
        assert!(after.contains("# operator note"), "{after}");
        assert!(after.contains("# keep me"), "{after}");
        assert!(
            after.contains("[extension]"),
            "unknown table survived: {after}"
        );
    }

    #[test]
    fn optional_fields_clear_with_an_empty_or_none_value() {
        let defaults =
            toml::to_string_pretty(&AgentConfig::default()).expect("serialize agent defaults");
        let seed = format!("display_name = \"old\"\n{defaults}");
        let (_dir, selection) = temp_selection(ConfigTarget::Agent, &seed);
        set(ConfigTarget::Agent, &selection, "display_name", "none").expect("clear");
        let content = fs::read_to_string(&selection.path).expect("read");
        assert!(!content.contains("display_name"), "{content}");
    }

    #[test]
    fn secrets_are_masked_and_files_are_private() {
        let (_dir, selection) = temp_selection(
            ConfigTarget::Agent,
            &toml::to_string_pretty(&AgentConfig::default()).expect("serialize"),
        );
        set(
            ConfigTarget::Agent,
            &selection,
            "auth_token",
            "super-secret",
        )
        .expect("set");
        let content = fs::read_to_string(&selection.path).expect("read");
        assert!(content.contains("super-secret"));
        let shown = rendered_config("agent", &content).expect("render");
        assert!(!shown.contains("super-secret"), "{shown}");
        assert!(shown.contains(MASK));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&selection.path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }
}
