// Integration-test target: `clippy.toml` allows `unwrap`/`expect` in tests,
// but clippy does not recognise a separate integration test binary as "tests".
#![allow(clippy::expect_used)]

//! The Agent management connection against a real Agent (`#565`).
//!
//! `AgentConnection` is the only path that speaks `agent.session.*` directly.
//! This proves the typed calls and the operator-credential handshake against
//! the Agent's own P2P listener rather than a fixture that agrees with itself.

use std::sync::Arc;
use std::time::Duration;

use nession_agent::config::AttachMode;
use nession_agent::p2p_credentials::P2pCredentials;
use nession_agent::server::websocket::{AgentServer, AgentServerContext};
use nession_agent::session::metadata::SessionMetadataStore;
use nession_agent::tmux::manager::SessionManager;
use nession_client::AgentConnection;
use nession_protocol::contracts::p2p::v1::CredentialScope;

const AGENT_ID: &str = "client-test-agent";
const CREDENTIAL: &str = "client-test-operator-token";

struct Agent {
    _dir: tempfile::TempDir,
    handle: nession_agent::server::ServerHandle,
    endpoint: String,
}

async fn start_agent() -> Agent {
    let dir = tempfile::tempdir().expect("tempdir");
    let (resize, _resize_updates) = nession_agent::server::ResizeReporter::new();
    let tmux = Arc::new(SessionManager::new());
    let credentials = Arc::new(P2pCredentials::new());
    credentials
        .grant_configured(AGENT_ID, CREDENTIAL, CredentialScope::for_standalone())
        .expect("grant the operator credential");
    let server = AgentServer::new(
        "127.0.0.1:0",
        AGENT_ID,
        None,
        dir.path().to_string_lossy().into_owned(),
        dir.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
        AgentServerContext {
            resize,
            credentials,
            mutations: nession_agent::execution::mutation_scheduler(),
            tmux: Arc::clone(&tmux),
            session_metadata: Arc::new(SessionMetadataStore::with_root(
                Arc::clone(&tmux),
                dir.path().join("sessions"),
            )),
            terminal_cols: nession_common::config::DEFAULT_TERMINAL_COLS,
            handshake_policy: Default::default(),
        },
    )
    .expect("agent server");
    let (handle, addr) = server.start().await.expect("start agent");
    tokio::time::sleep(Duration::from_millis(50)).await;
    Agent {
        _dir: dir,
        handle,
        endpoint: format!("ws://{addr}"),
    }
}

fn unique_name() -> String {
    format!("nession-client-test-{}", std::process::id())
}

#[tokio::test]
async fn the_agent_connection_lists_creates_and_kills_over_the_operator_credential() {
    let agent = start_agent().await;
    let mut connection = AgentConnection::connect(&agent.endpoint, CREDENTIAL)
        .await
        .expect("the operator credential authorizes the management socket");

    let listed = connection.list_sessions().await.expect("list");
    assert!(
        listed.sessions.is_empty(),
        "a fresh Agent has no tmux Sessions"
    );

    let name = unique_name();
    let created = connection
        .create_session(&name, None)
        .await
        .expect("create");
    assert_eq!(created.name, name);

    let listed = connection.list_sessions().await.expect("list");
    assert!(
        listed.sessions.iter().any(|session| session.name == name),
        "the created Session is missing from Agent truth"
    );

    let killed = connection.kill_session(&name).await.expect("kill");
    assert_eq!(killed.name, name);
    let listed = connection.list_sessions().await.expect("list");
    assert!(
        !listed.sessions.iter().any(|session| session.name == name),
        "a killed Session is still reported"
    );

    connection.close().await.expect("close");
    let _ = agent.handle.shutdown().await;
}

#[tokio::test]
async fn a_wrong_operator_credential_cannot_open_the_management_socket() {
    let agent = start_agent().await;
    assert!(
        AgentConnection::connect(&agent.endpoint, "not-the-token")
            .await
            .is_err(),
        "the Agent must refuse an unknown credential at the upgrade"
    );
    let _ = agent.handle.shutdown().await;
}
