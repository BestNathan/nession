//! #2267: the CLI's remote target and credential have one resolution chain.
//!
//! These tests launch the real CLI binary against controlled endpoints and
//! record which endpoint was actually dialled and what credential it was
//! presented, rather than asserting on the resolver in isolation — the defect
//! was that an operator's natural environment variable silently fell through
//! to localhost.

use futures_util::StreamExt;
use std::process::Command;
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

const URL_ENV: &str = "NESSION_SERVER_URL";
const URL_LEGACY_ENV: &str = "NENSION_SERVER_URL";
const TOKEN_ENV: &str = "NESSION_AUTH_TOKEN";
const TOKEN_LEGACY_ENV: &str = "NENSION_AUTH_TOKEN";
const SECRET: &str = "target-resolution-secret-2267";

/// A controlled endpoint that captures the first authenticated frame.
///
/// The CLI authenticates before it lists anything, so the first text frame on
/// this socket names the credential the CLI resolved. The endpoint then closes
/// the socket; the CLI reports its own connection failure, which is fine —
/// these tests are about which endpoint was chosen and what it was told.
struct Endpoint {
    port: u16,
    frames: Receiver<serde_json::Value>,
}

impl Endpoint {
    fn start() -> std::io::Result<Self> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
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
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                if let Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) =
                    socket.next().await
                {
                    if let Ok(frame) = serde_json::from_str(&text) {
                        let _ = tx.send(frame);
                    }
                }
            });
        });
        Ok(Self { port, frames })
    }

    fn url(&self) -> String {
        format!("ws://127.0.0.1:{}/ws", self.port)
    }

    /// The credential this endpoint was presented, if it was dialled at all.
    fn presented_token(&self) -> Option<String> {
        self.frames
            .recv_timeout(Duration::from_secs(10))
            .ok()
            .and_then(|frame| {
                frame
                    .get("payload")
                    .and_then(|payload| payload.get("auth_token"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
    }

    /// Whether nothing dialled this endpoint while the test waited.
    fn was_not_dialled(&self) -> bool {
        matches!(
            self.frames.recv_timeout(Duration::from_millis(400)),
            Err(mpsc::RecvTimeoutError::Timeout)
        )
    }
}

/// Run the real CLI binary with a clean target environment.
fn run_cli(args: &[&str], envs: &[(&str, String)]) -> std::io::Result<std::process::Output> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nession"));
    command
        .args(args)
        .env_remove(URL_ENV)
        .env_remove(URL_LEGACY_ENV)
        .env_remove(TOKEN_ENV)
        .env_remove(TOKEN_LEGACY_ENV)
        .env("NESSION_NO_UPDATE_CHECK", "1");
    for (key, value) in envs {
        command.env(key, value);
    }
    command.output()
}

fn combined_output(output: &std::process::Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn the_explicit_flag_beats_both_environment_names() {
    let flag = Endpoint::start().expect("flag endpoint");
    let canonical = Endpoint::start().expect("canonical endpoint");
    let legacy = Endpoint::start().expect("legacy endpoint");

    let output = run_cli(
        &[
            "--server-url",
            &flag.url(),
            "--auth-token",
            "flag-token",
            "agents",
            "list",
        ],
        &[
            (URL_ENV, canonical.url()),
            (URL_LEGACY_ENV, legacy.url()),
            (TOKEN_ENV, "canonical-token".to_string()),
            (TOKEN_LEGACY_ENV, "legacy-token".to_string()),
        ],
    )
    .expect("run the nession CLI");

    assert!(
        !output.status.success(),
        "the capturing endpoint closes before listing; the CLI must report a failure"
    );
    assert_eq!(
        flag.presented_token().as_deref(),
        Some("flag-token"),
        "the explicit flag's endpoint/credential must win: {}",
        combined_output(&output)
    );
    assert!(
        canonical.was_not_dialled(),
        "the canonical env endpoint must not be contacted when the flag is set"
    );
    assert!(
        legacy.was_not_dialled(),
        "the legacy env endpoint must not be contacted when the flag is set"
    );
}

#[test]
fn the_canonical_environment_beats_the_legacy_alias() {
    let canonical = Endpoint::start().expect("canonical endpoint");
    let legacy = Endpoint::start().expect("legacy endpoint");

    let output = run_cli(
        &["agents", "list"],
        &[
            (URL_ENV, canonical.url()),
            (URL_LEGACY_ENV, legacy.url()),
            (TOKEN_ENV, "canonical-token".to_string()),
            (TOKEN_LEGACY_ENV, "legacy-token".to_string()),
        ],
    )
    .expect("run the nession CLI");

    assert!(!output.status.success());
    assert_eq!(
        canonical.presented_token().as_deref(),
        Some("canonical-token"),
        "the canonical name must win the conflict: {}",
        combined_output(&output)
    );
    assert!(
        legacy.was_not_dialled(),
        "the legacy alias must not be dialled while the canonical name is set"
    );
}

#[test]
fn the_legacy_environment_is_honoured_on_its_own() {
    let legacy = Endpoint::start().expect("legacy endpoint");

    let output = run_cli(
        &["agents", "list"],
        &[
            (URL_LEGACY_ENV, legacy.url()),
            (TOKEN_LEGACY_ENV, "legacy-only-token".to_string()),
        ],
    )
    .expect("run the nession CLI");

    assert!(!output.status.success());
    assert_eq!(
        legacy.presented_token().as_deref(),
        Some("legacy-only-token"),
        "an existing environment using the legacy names must keep working: {}",
        combined_output(&output)
    );
}

#[test]
fn a_connection_failure_does_not_print_the_token() {
    // A port nothing listens on: bind one, remember it, release it.
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve a port");
        listener.local_addr().expect("reserved address").port()
    };

    let output = run_cli(
        &[
            "--server-url",
            &format!("ws://127.0.0.1:{port}/ws"),
            "--auth-token",
            SECRET,
            "agents",
            "list",
        ],
        &[],
    )
    .expect("run the nession CLI");

    assert!(!output.status.success());
    let text = combined_output(&output);
    assert!(
        text.contains("Failed to connect"),
        "the CLI's own failure sentence must travel: {text}"
    );
    assert!(
        !text.contains(SECRET),
        "a connection failure must not echo the credential: {text}"
    );
}

#[test]
fn help_documents_the_canonical_names_and_prints_no_token() {
    let output =
        run_cli(&["--help"], &[(TOKEN_ENV, SECRET.to_string())]).expect("run the nession CLI");

    assert!(output.status.success());
    let text = combined_output(&output);
    assert!(
        text.contains(URL_ENV) && text.contains(URL_LEGACY_ENV),
        "help must document the canonical name and its legacy alias: {text}"
    );
    assert!(
        text.contains(TOKEN_ENV) && text.contains(TOKEN_LEGACY_ENV),
        "help must document the credential names: {text}"
    );
    assert!(
        !text.contains(SECRET),
        "help must not disclose the credential value: {text}"
    );
}
