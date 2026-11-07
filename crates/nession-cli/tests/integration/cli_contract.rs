//! CLI process contract (#2869): configuration selection, typed editing and
//! the complete leaf-command help surface, exercised through the real
//! `nession` binary in an isolated `NESSION_HOME`.

use std::process::{Command, Output};
use tempfile::TempDir;

fn nession(home: &TempDir) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nession"));
    command
        .env("NESSION_NO_UPDATE_CHECK", "1")
        .env("NESSION_HOME", home.path())
        .env_remove("NESSION_SERVER_URL")
        .env_remove("NESSION_AUTH_TOKEN");
    command
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn missing(dir: &TempDir, name: &str) -> std::path::PathBuf {
    dir.path().join(name)
}

/// SC-01: an explicit `--config` that does not exist fails before startup with
/// an actionable file error, and no daemon banner is printed.
#[test]
fn an_explicit_missing_agent_config_fails_before_startup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = missing(&dir, "missing-agent.toml");
    let output = nession(&dir)
        .args(["agent", "start", "--config"])
        .arg(&path)
        .arg("--foreground")
        .output()
        .expect("run nession");

    assert!(!output.status.success(), "expected a non-zero exit");
    let error = stderr(&output);
    assert!(error.contains("does not exist"), "{error}");
    assert!(error.contains("config agent init"), "{error}");
    assert!(error.contains(&path.display().to_string()), "{error}");
    assert!(
        !stdout(&output).contains("Starting nession-agent"),
        "the daemon must not start: {}",
        stdout(&output)
    );
}

#[test]
fn an_explicit_missing_server_config_fails_before_startup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = missing(&dir, "missing-server.toml");
    let output = nession(&dir)
        .args(["server", "start", "--config"])
        .arg(&path)
        .arg("--foreground")
        .output()
        .expect("run nession");

    assert!(!output.status.success());
    let error = stderr(&output);
    assert!(error.contains("does not exist"), "{error}");
    assert!(error.contains("config server init"), "{error}");
    assert!(!stdout(&output).contains("Starting nession-server"));
}

#[test]
fn an_explicit_missing_config_also_fails_restart_before_startup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = missing(&dir, "missing-agent.toml");
    let output = nession(&dir)
        .args(["agent", "restart", "--config"])
        .arg(&path)
        .arg("--foreground")
        .output()
        .expect("run nession");

    assert!(!output.status.success());
    assert!(stderr(&output).contains("does not exist"));
}

#[cfg(unix)]
#[test]
fn an_unreadable_explicit_config_fails_with_the_selected_source() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("unreadable.toml");
    std::fs::write(&path, "server_url = \"ws://127.0.0.1:1\"\n").expect("seed");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).expect("chmod");

    let output = nession(&dir)
        .args(["agent", "start", "--config"])
        .arg(&path)
        .arg("--foreground")
        .output()
        .expect("run nession");

    // Restore so the temp directory can be removed on all platforms.
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));

    assert!(!output.status.success());
    let error = stderr(&output);
    assert!(error.contains("failed to read agent config"), "{error}");
    assert!(error.contains("selected by --config"), "{error}");
}

/// SC-01: the same command distinguishes explicit from implicit selection.
#[test]
fn implicit_and_explicit_config_selection_are_distinguishable() {
    let dir = tempfile::tempdir().expect("tempdir");

    let implicit = nession(&dir)
        .args(["config", "agent", "show"])
        .output()
        .expect("run show");
    assert!(implicit.status.success(), "{}", stderr(&implicit));
    assert!(
        stdout(&implicit).contains("No agent config file found"),
        "{}",
        stdout(&implicit)
    );

    let path = missing(&dir, "no-such.toml");
    let explicit = nession(&dir)
        .args(["config", "agent", "show", "--config"])
        .arg(&path)
        .output()
        .expect("run show");
    assert!(!explicit.status.success());
    assert!(stderr(&explicit).contains("does not exist"));
}

/// SC-02: `config init/show/set --config` operate on the named file; secrets
/// are masked; invalid keys/types leave the file untouched.
#[test]
fn agent_config_commands_edit_the_selected_file_without_leaking_or_mutating_on_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("custom-agent.toml");

    let init = nession(&dir)
        .args(["config", "agent", "init", "--config"])
        .arg(&path)
        .output()
        .expect("init");
    assert!(init.status.success(), "{}", stderr(&init));
    assert!(path.is_file());

    let set_level = nession(&dir)
        .args(["config", "agent", "set", "--config"])
        .arg(&path)
        .args(["logging.level", "debug"])
        .output()
        .expect("set level");
    assert!(set_level.status.success(), "{}", stderr(&set_level));
    assert!(std::fs::read_to_string(&path)
        .expect("read")
        .contains("debug"));

    let set_secret = nession(&dir)
        .args(["config", "agent", "set", "--config"])
        .arg(&path)
        .args(["auth_token", "super-secret-token"])
        .output()
        .expect("set secret");
    assert!(set_secret.status.success(), "{}", stderr(&set_secret));
    assert!(!stdout(&set_secret).contains("super-secret-token"));
    assert!(stdout(&set_secret).contains("********"));

    let show = nession(&dir)
        .args(["config", "agent", "show", "--config"])
        .arg(&path)
        .output()
        .expect("show");
    assert!(show.status.success());
    assert!(!stdout(&show).contains("super-secret-token"));
    assert!(stdout(&show).contains("********"));

    let before = std::fs::read_to_string(&path).expect("read before");
    let unknown = nession(&dir)
        .args(["config", "agent", "set", "--config"])
        .arg(&path)
        .args(["not_a_field", "x"])
        .output()
        .expect("unknown key");
    assert!(!unknown.status.success());
    assert!(stderr(&unknown).contains("unknown agent config key"));

    let invalid = nession(&dir)
        .args(["config", "agent", "set", "--config"])
        .arg(&path)
        .args(["heartbeat_interval_secs", "not-a-number"])
        .output()
        .expect("invalid type");
    assert!(!invalid.status.success());
    assert_eq!(
        before,
        std::fs::read_to_string(&path).expect("read after"),
        "a rejected set must not write the file"
    );
}

/// SC-02: Server configuration exposes the typed fields the model declares,
/// including the ones the old schema omitted.
#[test]
fn server_config_commands_edit_the_selected_file_with_typed_values() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("custom-server.toml");

    let init = nession(&dir)
        .args(["config", "server", "init", "--config"])
        .arg(&path)
        .output()
        .expect("init");
    assert!(init.status.success(), "{}", stderr(&init));

    for (key, value) in [
        ("terminal_stall_grace_secs", "31"),
        ("query_concurrency_per_connection", "4"),
        ("p2p_token_expiry_secs", "120"),
        ("terminal_web_font_size", "13.5"),
        ("logging.rotation", "hourly"),
    ] {
        let output = nession(&dir)
            .args(["config", "server", "set", "--config"])
            .arg(&path)
            .args([key, value])
            .output()
            .expect("set");
        assert!(output.status.success(), "set {key}: {}", stderr(&output));
    }

    let content = std::fs::read_to_string(&path).expect("read");
    let config: nession_common::config::ServerConfig =
        toml::from_str(&content).expect("typed server config");
    assert_eq!(config.terminal_stall_grace_secs, 31);
    assert_eq!(config.query_concurrency_per_connection, 4);
    assert_eq!(config.p2p_token_expiry_secs, 120);
    assert!((config.terminal_web_font_size - 13.5).abs() < f64::EPSILON);
    assert_eq!(config.logging.rotation, "hourly");
}

/// #2889 SC-01, stated once for every generated Server config: a blank
/// `auth_token` may only be paired with a loopback listener.
fn assert_safe_server_pairing(path: &std::path::Path) {
    let content = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("read generated server config {}: {error}", path.display()));
    let config: nession_common::config::ServerConfig = toml::from_str(&content)
        .unwrap_or_else(|error| panic!("generated file must be a typed Server config: {error}"));
    assert!(
        config.auth_token.is_empty(),
        "init must not invent a credential: {}",
        config.auth_token
    );
    let listen: std::net::SocketAddr = config
        .listen_address
        .parse()
        .unwrap_or_else(|error| panic!("the generated listener must be host:port: {error}"));
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

/// #2889 SC-01: the advertised setup path generates a local no-auth mode, not
/// an all-interface listener without a credential.
#[test]
fn server_init_generates_a_loopback_listener_with_a_blank_token() {
    let dir = tempfile::tempdir().expect("tempdir");
    let default = dir.path().join("server-config.toml");

    let init = nession(&dir)
        .args(["config", "server", "init"])
        .output()
        .expect("init");
    assert!(init.status.success(), "{}", stderr(&init));
    assert_safe_server_pairing(&default);

    // `--force` must obey the same generation rule.
    let forced = nession(&dir)
        .args(["config", "server", "init", "--force"])
        .output()
        .expect("force init");
    assert!(forced.status.success(), "{}", stderr(&forced));
    assert_safe_server_pairing(&default);
}

/// #2889 SC-01: an explicit `--config` file uses the same safe profile, and a
/// `--force` rewrite cannot reintroduce the all-interface/blank-token pairing.
#[test]
fn server_init_with_an_explicit_config_keeps_the_safe_pairing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("custom-server.toml");

    let init = nession(&dir)
        .args(["config", "server", "init", "--config"])
        .arg(&path)
        .output()
        .expect("init");
    assert!(init.status.success(), "{}", stderr(&init));
    assert_safe_server_pairing(&path);

    std::fs::write(
        &path,
        "listen_address = \"0.0.0.0:19090\"\ntls_cert_path = \"\"\ntls_key_path = \"\"\nauth_token = \"operator-secret\"\n",
    )
    .expect("seed operator config");

    let forced = nession(&dir)
        .args(["config", "server", "init", "--force", "--config"])
        .arg(&path)
        .output()
        .expect("force init");
    assert!(forced.status.success(), "{}", stderr(&forced));
    assert_safe_server_pairing(&path);
}

/// #2889 SC-02: an operator-authored remote/authenticated config stays intact;
/// a CLI read must not rewrite it or un-mask its credential.
#[test]
fn an_operator_authored_remote_server_config_is_not_rewritten() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("remote-server.toml");
    let seeded = "listen_address = \"0.0.0.0:19090\"\ntls_cert_path = \"\"\ntls_key_path = \"\"\nauth_token = \"operator-secret\"\n";
    std::fs::write(&path, seeded).expect("seed");

    let show = nession(&dir)
        .args(["config", "server", "show", "--config"])
        .arg(&path)
        .output()
        .expect("show");
    assert!(show.status.success(), "{}", stderr(&show));
    let shown = stdout(&show);
    assert!(
        shown.contains("0.0.0.0:19090"),
        "an explicit remote listener must stay visible: {shown}"
    );
    assert!(
        !shown.contains("operator-secret"),
        "the credential must stay masked: {shown}"
    );
    assert_eq!(
        seeded,
        std::fs::read_to_string(&path).expect("read after"),
        "reading a config must not rewrite it"
    );
}

/// Without `--config`, the same commands use the target's documented default
/// path under the isolated `NESSION_HOME`.
#[test]
fn config_commands_use_the_default_path_when_no_config_is_named() {
    let dir = tempfile::tempdir().expect("tempdir");
    let init = nession(&dir)
        .args(["config", "agent", "init"])
        .output()
        .expect("init");
    assert!(init.status.success(), "{}", stderr(&init));
    let default = dir.path().join("agent-config.toml");
    assert!(default.is_file(), "default config path was not used");

    let set = nession(&dir)
        .args(["config", "agent", "set", "agent_id", "default-agent"])
        .output()
        .expect("set");
    assert!(set.status.success(), "{}", stderr(&set));
    assert!(std::fs::read_to_string(&default)
        .expect("read")
        .contains("default-agent"));
}

/// SC-04: the real binary exposes every leaf command's help successfully.
#[test]
fn every_leaf_command_help_succeeds() {
    let dir = tempfile::tempdir().expect("tempdir");
    let leaves: &[&[&str]] = &[
        &["agent", "start"],
        &["agent", "stop"],
        &["agent", "restart"],
        &["agent", "status"],
        &["agent", "install-service"],
        &["agent", "uninstall-service"],
        &["server", "start"],
        &["server", "stop"],
        &["server", "restart"],
        &["server", "status"],
        &["agents", "list"],
        &["sessions", "list"],
        &["sessions", "create"],
        &["sessions", "attach"],
        &["sessions", "kill"],
        &["config", "agent", "init"],
        &["config", "agent", "show"],
        &["config", "agent", "set"],
        &["config", "server", "init"],
        &["config", "server", "show"],
        &["config", "server", "set"],
        &["update"],
    ];

    let root = nession(&dir).arg("--help").output().expect("root help");
    assert!(root.status.success());
    let help = stdout(&root);
    for family in ["agent", "server", "agents", "sessions", "config", "update"] {
        assert!(help.contains(family), "missing {family}: {help}");
    }

    for leaf in leaves {
        let output = nession(&dir)
            .args(*leaf)
            .arg("--help")
            .output()
            .expect("leaf help");
        assert!(
            output.status.success(),
            "{leaf:?} --help failed: {}",
            stderr(&output)
        );
    }
}

/// SC-05: documented CLI examples parse against the real parser, and every
/// config key shown in the README belongs to the editable schema.
#[test]
fn documented_examples_and_config_keys_match_the_parser_and_schema() {
    use clap::Parser;
    use nession_cli::args::Cli;
    use nession_cli::configuration::{AGENT_FIELDS, SERVER_FIELDS};
    use std::collections::BTreeSet;

    let readme = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md"))
        .expect("read README");

    let mut in_fence = false;
    let mut language = String::new();
    let mut checked_commands = 0;
    let mut documented_keys = BTreeSet::new();

    for raw in readme.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("```") {
            if in_fence {
                in_fence = false;
            } else {
                in_fence = true;
                language = rest.trim().to_string();
            }
            continue;
        }
        if !in_fence {
            continue;
        }
        if language == "toml" {
            if let Some((key, _)) = line.split_once('=') {
                let key = key.trim();
                if !key.is_empty() && !key.starts_with('#') {
                    documented_keys.insert(key.to_string());
                }
            }
            continue;
        }
        if language != "bash" {
            continue;
        }
        let Some(command) = line.strip_prefix("nession ") else {
            continue;
        };
        let command = command.split(" #").next().unwrap_or(command).trim();
        // Placeholders and alternative spellings are documentation, not a
        // literal invocation.
        if command.contains('<') || command.contains('[') || command.contains('|') {
            continue;
        }
        let mut argv = vec!["nession"];
        argv.extend(command.split_whitespace());
        Cli::try_parse_from(&argv)
            .unwrap_or_else(|error| panic!("README example does not parse: `{line}`: {error}"));
        checked_commands += 1;
    }

    assert!(
        checked_commands >= 3,
        "expected documented CLI examples, checked {checked_commands}"
    );

    let agent_keys: BTreeSet<&str> = AGENT_FIELDS
        .iter()
        .map(|field| field.key.split('.').next().unwrap_or(field.key))
        .collect();
    let server_keys: BTreeSet<&str> = SERVER_FIELDS
        .iter()
        .map(|field| field.key.split('.').next().unwrap_or(field.key))
        .collect();
    for key in documented_keys {
        assert!(
            agent_keys.contains(key.as_str()) || server_keys.contains(key.as_str()),
            "README documents config key '{key}' that neither schema owns"
        );
    }
}

/// SC-04: `status` reports the config the running process recorded. It must
/// never present a default file's values as live state.
#[test]
fn status_reports_the_recorded_config_source_not_a_default_file() {
    use nession_cli::lifecycle::pid_file::{self, Component};
    use std::path::Path;

    let dir = tempfile::tempdir().expect("tempdir");
    let pid_path = dir.path().join("agent.pid");
    pid_file::write_identity(
        pid_path.to_str().expect("utf-8 path"),
        Component::Agent,
        Some(Path::new("/custom/running-agent.toml")),
    )
    .expect("write identity");

    // A default file with a distinctive value: status must not read it.
    std::fs::write(
        dir.path().join("agent-config.toml"),
        "agent_id = \"default-file-value\"\nserver_url = \"ws://127.0.0.1:1\"\nauth_token = \"\"\n",
    )
    .expect("seed default config");

    let output = nession(&dir)
        .args(["agent", "status", "--pid-file"])
        .arg(&pid_path)
        .output()
        .expect("run status");
    assert!(output.status.success(), "{}", stderr(&output));
    let text = stdout(&output);
    assert!(
        text.contains("/custom/running-agent.toml (recorded by the running process)"),
        "{text}"
    );
    assert!(
        !text.contains("default-file-value"),
        "status presented default-file values as live state: {text}"
    );

    // A process that recorded no config source is labelled unknown.
    let unknown_path = dir.path().join("agent-unknown.pid");
    pid_file::write_identity(
        unknown_path.to_str().expect("utf-8 path"),
        Component::Agent,
        None,
    )
    .expect("write identity without config");
    let unknown = nession(&dir)
        .args(["agent", "status", "--pid-file"])
        .arg(&unknown_path)
        .output()
        .expect("run status");
    assert!(unknown.status.success());
    assert!(
        stdout(&unknown).contains("Config: unknown"),
        "{}",
        stdout(&unknown)
    );
}

/// SC-01: omitting `--config` selects the documented default path. Point the
/// default file at invalid TOML: the start command must read it and fail on
/// it, which distinguishes implicit selection from no selection at all.
#[test]
fn start_reads_the_default_agent_config_when_no_explicit_path_is_named() {
    let dir = tempfile::tempdir().expect("tempdir");
    let default = dir.path().join("agent-config.toml");
    std::fs::write(&default, "this is not = valid [toml\n").expect("seed invalid default");

    let output = nession(&dir)
        .args(["agent", "start", "--foreground"])
        .output()
        .expect("run nession");

    assert!(!output.status.success());
    let error = stderr(&output);
    assert!(
        error.contains("failed to parse agent config"),
        "the implicit default was not loaded: {error}"
    );
    assert!(
        error.contains(&default.display().to_string()),
        "the error must name the default path: {error}"
    );
    assert!(
        error.contains("selected by the default path"),
        "the source must be identified as implicit: {error}"
    );
}

#[test]
fn start_reads_the_default_server_config_when_no_explicit_path_is_named() {
    let dir = tempfile::tempdir().expect("tempdir");
    let default = dir.path().join("server-config.toml");
    std::fs::write(&default, "this is not = valid [toml\n").expect("seed invalid default");

    let output = nession(&dir)
        .args(["server", "start", "--foreground"])
        .output()
        .expect("run nession");

    assert!(!output.status.success());
    let error = stderr(&output);
    assert!(error.contains("failed to parse server config"), "{error}");
    assert!(error.contains(&default.display().to_string()), "{error}");
}
