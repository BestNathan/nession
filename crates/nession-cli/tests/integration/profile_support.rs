//! Shared fixtures for the #4682 client-profile subprocess regressions.
//!
//! Every test drives the **real** `nession` binary in an isolated
//! `NESSION_HOME` against controlled WebSocket endpoints with distinct canary
//! credentials, and asserts process exit/stdout/stderr plus the destination
//! actually dialled — never a source-only claim.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tempfile::TempDir;

/// An isolated installation home.
pub struct Home {
    pub dir: TempDir,
}

impl Home {
    pub fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("tempdir"),
        }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    pub fn store_path(&self) -> PathBuf {
        self.path().join("client-config.toml")
    }

    pub fn store_text(&self) -> Option<String> {
        std::fs::read_to_string(self.store_path()).ok()
    }

    pub fn credential_path(&self, profile: &str) -> PathBuf {
        self.path()
            .join("client-credentials")
            .join(format!("{profile}.toml"))
    }

    /// The real CLI with a clean, isolated target/profile environment and the
    /// deterministic private-file credential backend.
    pub fn nession(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nession"));
        command
            .env("NESSION_HOME", self.path())
            .env("NESSION_RUNTIME_DIR", self.path().join("runtime"))
            .env("NESSION_NO_UPDATE_CHECK", "1")
            .env("NESSION_CREDENTIAL_STORE", "file")
            .env_remove("NESSION_SERVER_URL")
            .env_remove("NENSION_SERVER_URL")
            .env_remove("NESSION_AUTH_TOKEN")
            .env_remove("NENSION_AUTH_TOKEN")
            .env_remove("NESSION_PROFILE")
            .env_remove("NESSION_VERSION")
            .env_remove("NESSION_VERSION_DISPATCHED")
            .env_remove("NESSION_CLIENT_HOME");
        command
    }

    /// Write an Agent config with distinct daemon canary credentials.
    pub fn write_agent_config(&self, server_url: &str) {
        std::fs::write(
            self.path().join("agent-config.toml"),
            format!(
                "server_url = \"{server_url}\"\n\
                 auth_token = \"daemon-auth-canary-4682\"\n\
                 agent_token = \"daemon-agent-canary-4682\"\n"
            ),
        )
        .expect("write agent config");
    }
}

/// Run a CLI command to completion.
pub fn run(command: &mut Command) -> Output {
    command.output().expect("run the nession CLI")
}

/// Run a CLI command with a credential piped to stdin (`--stdin`).
pub fn run_with_stdin(command: &mut Command, secret: &str) -> Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the nession CLI");
    child
        .stdin
        .take()
        .expect("stdin pipe")
        .write_all(secret.as_bytes())
        .expect("write credential to stdin");
    child.wait_with_output().expect("wait for the nession CLI")
}

pub fn combined(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// How a controlled endpoint answers the auth handshake.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Auth {
    Accept,
    Deny,
    /// Accept the socket but never answer: drives the bounded timeout path.
    Silent,
}

/// A controlled authenticated WebSocket endpoint.
///
/// Captures every presented credential (one per connection), answers the
/// handshake per [`Auth`], and serves empty agent/session lists so a successful
/// command completes. Sequential connections are accepted so successive CLI
/// processes can dial the same endpoint.
pub struct Endpoint {
    port: u16,
    frames: Receiver<String>,
}

impl Endpoint {
    pub fn start(auth: Auth) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind endpoint");
        listener.set_nonblocking(true).expect("nonblocking");
        let port = listener.local_addr().expect("addr").port();
        let (tx, frames) = mpsc::channel();
        std::thread::spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            runtime.block_on(async move {
                let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
                    return;
                };
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        return;
                    };
                    let tx = tx.clone();
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                        continue;
                    };
                    while let Some(Ok(frame)) = socket.next().await {
                        let tokio_tungstenite::tungstenite::Message::Text(text) = frame else {
                            break;
                        };
                        let Ok(envelope) = serde_json::from_str::<serde_json::Value>(&text) else {
                            break;
                        };
                        let wire = envelope
                            .get("msg_type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let id = envelope.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let payload = match wire {
                            "server.auth" => {
                                let token = envelope
                                    .get("payload")
                                    .and_then(|p| p.get("auth_token"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let _ = tx.send(token);
                                match auth {
                                    Auth::Accept => serde_json::json!({
                                        "status": "success", "message": "ok"
                                    }),
                                    Auth::Deny => serde_json::json!({
                                        "status": "error", "message": "invalid token"
                                    }),
                                    Auth::Silent => continue,
                                }
                            }
                            "server.agent.list" => serde_json::json!({ "agents": [] }),
                            "server.session.list" => {
                                serde_json::json!({ "sessions": [], "stale_agents": [] })
                            }
                            _ => serde_json::json!({}),
                        };
                        let reply = serde_json::json!({
                            "msg_type": wire,
                            "id": id,
                            "timestamp": 0,
                            "payload": payload,
                        });
                        if socket
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                reply.to_string(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            });
        });
        Self { port, frames }
    }

    pub fn url(&self) -> String {
        format!("ws://127.0.0.1:{}/ws", self.port)
    }

    /// A spelling of this endpoint that canonicalizes equal (trailing slash).
    pub fn url_alias(&self) -> String {
        format!("ws://127.0.0.1:{}/ws/", self.port)
    }

    /// The first credential presented, waiting for a dial.
    pub fn presented_token(&self) -> Option<String> {
        self.frames.recv_timeout(Duration::from_secs(10)).ok()
    }

    /// Whether nothing dialled this endpoint while the test waited.
    pub fn was_not_dialled(&self) -> bool {
        matches!(
            self.frames.recv_timeout(Duration::from_millis(400)),
            Err(mpsc::RecvTimeoutError::Timeout)
        )
    }
}

/// A port nothing listens on (bind, remember, release).
pub fn dead_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve a port");
    listener.local_addr().expect("reserved address").port()
}

/// Add a profile through the real CLI and assert success.
pub fn add_profile(home: &Home, name: &str, url: &str) {
    let output = run(home
        .nession()
        .args(["profile", "add", name, "--server-url", url]));
    assert!(
        output.status.success(),
        "profile add {name} must succeed: {}",
        combined(&output)
    );
}

/// Store a credential through the real CLI's stdin path.
pub fn set_credential(home: &Home, name: &str, secret: &str) {
    let output = run_with_stdin(
        home.nession()
            .args(["profile", "credential", "set", name, "--stdin"]),
        secret,
    );
    assert!(
        output.status.success(),
        "credential set {name} must succeed: {}",
        combined(&output)
    );
}
