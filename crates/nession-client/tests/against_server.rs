//! The client against a real Server.
//!
//! The mock suite proves correlation; this one proves the **contracts**. Every
//! assertion here is on a reply the Server actually builds, so a contract that
//! drifted from its handler fails here rather than passing against a fixture
//! that was written from the same reading as the code under test.
//!
//! Deliberately not converted: `crates/nession-server/tests/integration/**`.
//! Those must keep speaking raw JSON — they are the proof that the envelope's
//! four keys and each refusal's shape are what the contracts say, and a Server
//! whose own tests speak through this client could no longer see its wire.

use std::sync::Arc;

use nession_client::{AttachMode, ClientConfig, ClientConnection, ClientError};
use nession_common::config::ServerConfig;
use nession_common::readiness::Readiness;
use nession_protocol::contracts::agent::v1::AgentListReply;
use nession_protocol::contracts::session::v1::{ClientSessionAttachReply, ServerSessionListReply};
use nession_server::db::Database;
use nession_server::server::WebSocketServer;

type TestResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Boot a real Server on an OS-assigned port, with its own database.
///
/// `127.0.0.1:0` rather than a fixed port, and a `tempfile::TempDir` rather
/// than a name built from the clock: concurrent runs of this suite must not
/// contend for either. The `TempDir` comes back to the caller so it stays alive
/// — dropping it removes the database and its WAL sidecars.
async fn start_server(auth_token: &str) -> TestResult<(tempfile::TempDir, String)> {
    let dir = tempfile::tempdir()?;
    let config = ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: auth_token.to_string(),
        db_path: dir.path().join("server.db").to_string_lossy().into_owned(),
        ..Default::default()
    };

    let db = Database::new(&config.db_path).await?;
    let mut server = WebSocketServer::new(config, Arc::new(db)).await?;
    let addr = server.local_addr()?;

    tokio::spawn(async move {
        let _ = server.run(Readiness::Unwatched).await;
    });

    // No sleep before returning: the listener is bound and its accept backlog
    // holds a connection until `run` picks it up.
    Ok((dir, format!("ws://{addr}")))
}

/// A connected, authenticated client against a freshly booted Server.
async fn client_for(token: &str) -> TestResult<(tempfile::TempDir, ClientConnection)> {
    let (dir, url) = start_server(token).await?;
    let client = ClientConnection::connect(ClientConfig::new(&url, token)).await?;
    Ok((dir, client))
}

#[tokio::test]
async fn a_real_server_answers_the_agent_list() {
    let (_dir, mut client) = client_for("token").await.unwrap();

    match client.list_agents().await.unwrap() {
        AgentListReply::Listed(list) => {
            assert!(
                list.agents.is_empty(),
                "nothing has registered with this server"
            );
        }
        AgentListReply::Refused(refusal) => {
            panic!(
                "a real server refused `server.agent.list`: {}",
                refusal.message
            )
        }
    }
}

#[tokio::test]
async fn a_real_server_answers_the_session_list() {
    let (_dir, mut client) = client_for("token").await.unwrap();

    match client.list_sessions(None).await.unwrap() {
        ServerSessionListReply::Listed(list) => {
            assert!(list.sessions.is_empty(), "this server has no sessions");
        }
        ServerSessionListReply::Refused(refusal) => {
            panic!(
                "a real server refused `server.session.list`: {}",
                refusal.message
            )
        }
    }
}

/// A wrong token is refused, and the **Server's own sentence** is what travels.
///
/// Asserted against the literal the handler builds rather than against
/// "non-empty": the point of carrying `message` out to the caller is that it is
/// distinguishable, and a test that accepts any string would pass on a client
/// that invented one.
#[tokio::test]
async fn a_bad_token_is_refused_with_the_servers_own_words() {
    let (_dir, url) = start_server("the-right-token").await.unwrap();

    let error = match ClientConnection::connect(ClientConfig::new(&url, "the-wrong-token")).await {
        Ok(_) => panic!("a wrong token must not produce a connection"),
        Err(error) => error,
    };

    match error {
        ClientError::Auth { message } => assert_eq!(message, "Invalid auth token"),
        other => panic!("expected an auth error, got {other:?}"),
    }
}

/// A refused attach decodes, and carries **the Server's own reason**.
///
/// This is the test that found the contract was wrong. It was written expecting
/// a decode failure on the *shape of the reason*, and failed for a larger
/// reason: the reply would not decode at all — `missing field 'mode'` — because
/// `server.session.attach`'s contract was one flat struct demanding a `mode`
/// that a refusal has never sent. Pointing a typed consumer at the wire is what
/// surfaced it; a hand-decoding consumer cannot, because it asks for the fields
/// it happens to want and never notices the ones that are absent.
///
/// The handler was right the whole time. Only the description of it changed.
#[tokio::test]
async fn a_failed_attach_carries_the_servers_reason() {
    let (_dir, mut client) = client_for("token").await.unwrap();

    let reply = client
        .request_attach("no-such-agent:no-such-session", AttachMode::P2p)
        .await
        .expect("the server answers even to refuse");

    match reply {
        ClientSessionAttachReply::Refused(refusal) => {
            assert_eq!(refusal.status, "error");
            assert!(
                !refusal.message.is_empty(),
                "the server's reason must say something"
            );
        }
        ClientSessionAttachReply::Attached(attach) => {
            panic!("there is no such session, yet the server sent a plan: {attach:?}")
        }
    }
}
