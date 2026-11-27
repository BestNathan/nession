//! #4588 SC-02 — the real `deploy/entrypoint-agent.sh` projection feeds the
//! canonical `AgentConfig` parser.
//!
//! This proves the advertised-endpoint boundary *between* the OCI entrypoint
//! and the Rust reader, not the two sides separately: the canonical WSS hosts
//! are projected and accepted, the legacy `nhome.local` `connect_url` is
//! preserved, and a non-WebSocket / credentialed / malformed advertised URL
//! fails closed at the canonical reader before the Agent could start.
//!
//! No tmux, nginx, network or production credentials: the entrypoint's
//! config-only seam generates the file into a private temp dir and exits.

#![allow(clippy::expect_used, clippy::indexing_slicing)]

use nession_agent::config::AgentConfig;
use std::path::{Path, PathBuf};
use std::process::Command;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repository root resolves")
}

/// Run the real entrypoint's config generation and return the produced file.
fn project(advertise: Option<&str>) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("private temp dir");
    let config_dir = dir.path().join("etc-nession");
    let mut cmd = Command::new("sh");
    cmd.arg(repo_root().join("deploy/entrypoint-agent.sh"))
        .current_dir(repo_root())
        .env("NESSON_CONFIG_DIR", &config_dir)
        .env("NESSON_CONFIG_ONLY", "1")
        .env("AGENT_ID", "entrypoint-advertise-test")
        .env("AGENT_SERVER_URL", "ws://nession-server-staging:18080")
        .env("AGENT_AUTH_TOKEN", "test-outbound-token")
        .env("AGENT_TOKEN", "test-inbound-token")
        .env(
            "AGENT_CONNECT_URL",
            "ws://staging.agent.nession.nhome.local/ws",
        )
        .env_remove("AGENT_ADVERTISE_URLS");
    if let Some(urls) = advertise {
        cmd.env("AGENT_ADVERTISE_URLS", urls);
    }
    let output = cmd.output().expect("spawn entrypoint-agent.sh");
    assert!(
        output.status.success(),
        "entrypoint config generation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let file = config_dir.join("agent-config.toml");
    assert!(file.exists(), "entrypoint produced no agent-config.toml");
    (dir, file)
}

fn parse(file: &Path) -> AgentConfig {
    let text = std::fs::read_to_string(file).expect("read generated config");
    toml::from_str(&text).expect("generated config parses as AgentConfig")
}

#[test]
fn canonical_wss_endpoints_project_and_validate() {
    let (_dir, file) = project(Some(
        "wss://staging-agent-nession.bestnathan.top/ws,wss://staging-01-agent-nession.bestnathan.top/ws",
    ));
    let config = parse(&file);
    config.validate().expect("canonical WSS endpoints validate");
    // The legacy LAN endpoint is preserved verbatim alongside the new hosts.
    assert_eq!(
        config.connect_url.as_deref(),
        Some("ws://staging.agent.nession.nhome.local/ws")
    );
    assert_eq!(config.advertise_addresses.len(), 2);
    assert_eq!(
        config.advertise_addresses[0].url,
        "wss://staging-agent-nession.bestnathan.top/ws"
    );
    assert_eq!(
        config.advertise_addresses[1].url,
        "wss://staging-01-agent-nession.bestnathan.top/ws"
    );
    assert_eq!(
        config.advertise_addresses[0].network_type,
        nession_protocol::contracts::agent::v1::NetworkType::Tunnel
    );
}

#[test]
fn unset_advertise_keeps_legacy_connect_url_only() {
    let (_dir, file) = project(None);
    let config = parse(&file);
    config.validate().expect("legacy-only config validates");
    assert!(config.advertise_addresses.is_empty());
    assert_eq!(
        config.connect_url.as_deref(),
        Some("ws://staging.agent.nession.nhome.local/ws")
    );
}

#[test]
fn non_websocket_advertise_fails_closed_at_the_reader() {
    // The projection writes through unvalidated (like connect_url); the
    // canonical reader is the fail-closed boundary that refuses the downgrade.
    let (_dir, file) = project(Some("http://staging-agent-nession.bestnathan.top/ws"));
    let config = parse(&file);
    let error = config
        .validate()
        .expect_err("http advertised endpoint must be refused");
    assert!(
        error.to_string().contains("advertise_addresses[0].url"),
        "{error}"
    );
}

#[test]
fn credentialed_advertise_fails_closed_at_the_reader() {
    let (_dir, file) = project(Some(
        "wss://user:pass@staging-agent-nession.bestnathan.top/ws",
    ));
    let config = parse(&file);
    assert!(
        config.validate().is_err(),
        "userinfo in an advertised URL must be refused"
    );
}

#[test]
fn malformed_advertise_toml_fails_closed_at_parse() {
    // A quote injected through the environment breaks the TOML quoting; the
    // canonical parser refuses the file rather than advertising a broken URL.
    let (_dir, file) = project(Some("wss://staging-agent-nession.bestnathan.top/ws\""));
    let text = std::fs::read_to_string(&file).expect("read generated config");
    assert!(
        toml::from_str::<AgentConfig>(&text).is_err(),
        "malformed projected TOML must fail closed"
    );
}
