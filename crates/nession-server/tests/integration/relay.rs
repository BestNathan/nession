//! Integration tests for relay mode: browser → server → agent → tmux
//!
//! These tests verify the complete relay chain:
//! 1. Client sends server.session.attach (preferred_mode=relay) to server
//! 2. Server responds with success and enters relay forwarding mode
//! 3. Server connects to agent's internal WS, sends agent.attach
//! 4. Agent creates PTY, sends terminal.output
//! 5. Server forwards terminal.output to browser
//! 6. Browser sends terminal.input → server forwards to agent → PTY

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use nession_agent::config::AttachMode;
use nession_agent::connection::ServerClient;
use nession_agent::server::websocket::{AgentServer, AgentServerContext};
use nession_agent::sync::heartbeat::HeartbeatLoop;
use nession_agent::sync::session_watcher::SessionWatcher;
use nession_agent::tmux::manager::SessionManager;
use nession_common::config::ServerConfig;
use nession_protocol::contracts::agent::v1::AgentMetadata;
use nession_protocol::contracts::p2p::agent_url_with_credential;
use nession_protocol::contracts::p2p::v1::{CredentialScope, P2pGrantPayload};
use nession_server::db::Database;
use nession_server::server::WebSocketServer;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Generate a unique session name for tests.
fn unique_session_name(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("nession-test-{prefix}-{nanos}")
}
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Build a standard protocol message.
fn msg(msg_type: &str, id: &str, payload: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "msg_type": msg_type,
        "id": id,
        "timestamp": ts(),
        "payload": payload,
    })
}

/// Start the central server on an ephemeral port.
///
/// The database lives in its own `TempDir`, returned so the caller keeps it
/// alive. A `temp_dir()/nession_test_relay_<secs>_<counter>.db` name collided
/// between concurrent test runs — same second, same starting counter, same file.
async fn start_server(
    auth_token: &str,
) -> anyhow::Result<(
    std::net::SocketAddr,
    tokio::task::JoinHandle<()>,
    tempfile::TempDir,
)> {
    let db_dir = tempfile::tempdir()?;
    let db_path = db_dir
        .path()
        .join("server.db")
        .to_string_lossy()
        .into_owned();

    let config = ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: auth_token.to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path: db_path.clone(),
        ..Default::default()
    };

    let db = Database::new(&db_path).await?;
    let mut server = WebSocketServer::new(config, Arc::new(db)).await?;
    let addr = server.local_addr()?;

    let handle = tokio::spawn(async move {
        let _ = server
            .run(nession_common::readiness::Readiness::Unwatched)
            .await;
    });

    tokio::time::sleep(Duration::from_millis(100)).await;
    Ok((addr, handle, db_dir))
}

/// Start the agent's internal WebSocket server (for P2P/relay connections).
/// OS picks a free port; returns the real bound address, and the credential
/// store that listener verifies against.
///
/// The store is returned rather than kept private because the `ServerClient`
/// [`register_agent`] builds must write into **this** one. The Server pushes
/// the relay credential as `agent.p2p.grant` over the connection the agent
/// dialled out, and the Agent checks it on the listener the Server then dials —
/// so two stores would mean a credential granted into one and verified against
/// the other, which is a relay that refuses every legitimate attach. `runtime`
/// builds it once for exactly that reason (#1013); in production the store
/// reaches both through `AgentServerContext`.
async fn start_agent(
    agent_id: &str,
) -> anyhow::Result<(
    std::net::SocketAddr,
    nession_agent::server::ServerHandle,
    Arc<nession_agent::p2p_credentials::P2pCredentials>,
    nession_agent::execution::MutationLane,
)> {
    let tmp = Box::leak(Box::new(tempfile::tempdir()?));
    let (resize, _resize_updates) = nession_agent::server::ResizeReporter::new();
    let credentials = Arc::new(nession_agent::p2p_credentials::P2pCredentials::new());
    // One lane for both paths, as in production: this test pairs a listener
    // with a central connection over one agent, which is exactly the shape
    // #1021 is about, so a lane each would leave the invariant unexercised.
    let mutations = nession_agent::execution::mutation_scheduler();
    let server = AgentServer::new(
        "127.0.0.1:0",
        agent_id,
        None, // no TLS
        "/tmp".to_string(),
        tmp.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
        AgentServerContext {
            resize,
            credentials: Arc::clone(&credentials),
            mutations: Arc::clone(&mutations),
            tmux: Arc::new(SessionManager::new()),
            terminal_cols: nession_common::config::DEFAULT_TERMINAL_COLS,
        },
    )?;

    let (handle, addr) = server.start().await?;

    Ok((addr, handle, credentials, mutations))
}

/// Register an agent with the central server so it shows as Online.
///
/// `credentials` must be the store [`start_agent`] handed its listener, not a
/// fresh one: this connection is where the Server's `agent.p2p.grant` lands,
/// and the listener is where it is checked (#1013).
async fn register_agent(
    server_addr: std::net::SocketAddr,
    agent_id: &str,
    auth_token: &str,
    agent_port: u16,
    credentials: Arc<nession_agent::p2p_credentials::P2pCredentials>,
    mutations: nession_agent::execution::MutationLane,
) -> anyhow::Result<nession_agent::connection::ServerClientHandle> {
    let metadata = AgentMetadata {
        tmux_version: "3.3".to_string(),
        os_version: "Linux".to_string(),
        nession_version: "0.1.0".to_string(),
        image_tag: "test".to_string(),
    };

    let client = ServerClient::new(
        format!("ws://{server_addr}"),
        auth_token,
        agent_id,
        "test-host",
        "127.0.0.1",
        agent_port,
        None,   // connect_url
        vec![], // addresses
        None,   // display_name
        metadata,
        Arc::new(SessionManager::new()),
        "/tmp".to_string(),
        // A real registry, because registration is refused without a manifest
        // and `connect_and_run` spawns the connection — so a refused agent
        // would still return `Ok` here while its socket was already dead, and
        // the failure would surface much later as a missing session. Uses the
        // composition `main` uses, so this exercises the manifest an agent
        // really registers.
        Some(Arc::new(nession_agent::extension::ExtensionRegistry::new(
            agent_id,
            Vec::new(),
            nession_agent::protocol::served_descriptors()?,
        )?)),
        credentials,
        mutations,
    );

    Ok(client.connect_and_run().await?.0)
}

/// Send a JSON text frame and return the next text frame (skipping non-text).
async fn send_and_recv(
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        WsMessage,
    >,
    stream: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    request: &serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    let request_id = request["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("request has no string id"))?
        .to_string();
    sink.send(WsMessage::Text(request.to_string())).await?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            panic!("timeout waiting for response to {request_id}");
        }
        match tokio::time::timeout(Duration::from_secs(2), stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text)?;
                if parsed.get("id").and_then(serde_json::Value::as_str) == Some(request_id.as_str())
                {
                    return Ok(parsed);
                }
                // Unsolicited message (e.g. terminal.output) — skip.
            }
            Ok(Some(Ok(_))) => continue, // non-text frame
            Ok(Some(Err(e))) => panic!("WS error: {e}"),
            Ok(None) => panic!("stream closed"),
            Err(_timeout) => continue,
        }
    }
}

/// Poll the *actual* Server session registry instead of assuming that a fixed
/// sleep is enough for registration, the watcher and the async session update.
///
/// The only success condition is the complete, exact agent:session ID. On CI
/// saturation, preserve the last discovery response so a failure distinguishes
/// "no agent", "agent stale" and "other sessions appeared" (#1642).
async fn wait_for_discovered_session(
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        WsMessage,
    >,
    stream: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    agent_id: &str,
    expected_session_id: &str,
    budget: Duration,
    watcher_state: &str,
) -> anyhow::Result<()> {
    let deadline = tokio::time::Instant::now() + budget;
    let mut attempts = 0_u32;
    let mut observed: Vec<String> = Vec::new();
    let mut stale_agents: Vec<String> = Vec::new();
    let mut last_error = String::from("no discovery reply received");
    let mut agent_registration = String::from("not queried");

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            anyhow::bail!(
                "session discovery deadline exceeded for {expected_session_id} \
                 (agent={agent_id}, attempts={attempts}, observed_sessions={observed:?}, \
                 stale_agents={stale_agents:?}, agent_registration={agent_registration}, \
                 watcher_state={watcher_state}, last_response={last_error})"
            );
        }
        attempts += 1;
        // Capture real registration status, not merely the session list's empty
        // result. A non-forced session list cannot report an absent/offline agent.
        if attempts == 1 || attempts.is_multiple_of(5) {
            let registration_request = msg(
                "server.agent.list",
                &format!("discovery-agents-{attempts}"),
                serde_json::json!({}),
            );
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(
                remaining.min(Duration::from_secs(3)),
                send_and_recv(sink, stream, &registration_request),
            )
            .await
            {
                Ok(Ok(reply)) => {
                    let agents_list = reply
                        .pointer("/payload/agents")
                        .and_then(serde_json::Value::as_array);
                    if let Some(agents) = agents_list {
                        let registered_agent = agents.iter().find(|agent| {
                            agent.get("agent_id").and_then(serde_json::Value::as_str)
                                == Some(agent_id)
                        });
                        if let Some(agent) = registered_agent {
                            agent_registration = format!(
                                "status={}, session_count={}, active_sessions={}, heartbeat={}",
                                agent.get("status").unwrap_or(&serde_json::Value::Null),
                                agent
                                    .get("session_count")
                                    .unwrap_or(&serde_json::Value::Null),
                                agent
                                    .get("active_sessions")
                                    .unwrap_or(&serde_json::Value::Null),
                                agent
                                    .get("last_heartbeat")
                                    .unwrap_or(&serde_json::Value::Null),
                            );
                        } else {
                            agent_registration = "not registered".to_string();
                        }
                    } else {
                        agent_registration = format!(
                            "invalid agent list reply: {}",
                            reply.get("payload").unwrap_or(&serde_json::Value::Null)
                        );
                    }
                }
                Ok(Err(error)) => agent_registration = format!("query failed: {error}"),
                Err(_) => agent_registration = "query timed out".to_string(),
            }
        }
        // The agent lookup may have consumed the remaining budget.
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            continue;
        }
        let request = msg(
            "server.session.list",
            &format!("discovery-{attempts}"),
            serde_json::json!({ "agent_id": agent_id }),
        );
        match tokio::time::timeout(
            remaining.min(Duration::from_secs(3)),
            send_and_recv(sink, stream, &request),
        )
        .await
        {
            Ok(Ok(reply)) => {
                if let Some(sessions) = reply
                    .pointer("/payload/sessions")
                    .and_then(serde_json::Value::as_array)
                {
                    observed = sessions
                        .iter()
                        .filter_map(|s| {
                            s.get("session_id")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string)
                        })
                        .collect();
                    stale_agents = reply
                        .pointer("/payload/stale_agents")
                        .and_then(serde_json::Value::as_array)
                        .map(|agents| {
                            agents
                                .iter()
                                .filter_map(|id| id.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default();
                    if observed.iter().any(|id| id == expected_session_id) {
                        return Ok(());
                    }
                    last_error = format!(
                        "registry returned {} session(s), target not yet visible",
                        observed.len()
                    );
                } else {
                    last_error = format!(
                        "session.list reply missing sessions array: status={:?}",
                        reply
                            .pointer("/payload/status")
                            .and_then(serde_json::Value::as_str)
                    );
                }
            }
            Ok(Err(error)) => last_error = error.to_string(),
            Err(_) => last_error = "session.list response timed out".to_string(),
        }

        tokio::time::sleep(
            deadline
                .saturating_duration_since(tokio::time::Instant::now())
                .min(Duration::from_millis(150)),
        )
        .await;
    }
}

#[tokio::test]
async fn session_discovery_missing_id_fails_with_bounded_diagnostics() {
    let (server_addr, handle, _db_dir) = start_server("test-token").await.unwrap();
    let (ws, _) = connect_async(format!("ws://{server_addr}")).await.unwrap();
    let (mut sink, mut stream) = ws.split();
    let auth = msg(
        "server.auth",
        "auth-discovery-negative",
        serde_json::json!({ "auth_token": "test-token" }),
    );
    let reply = send_and_recv(&mut sink, &mut stream, &auth).await.unwrap();
    assert_eq!(
        reply
            .pointer("/payload/status")
            .and_then(serde_json::Value::as_str),
        Some("success")
    );

    let started = tokio::time::Instant::now();
    let error = wait_for_discovered_session(
        &mut sink,
        &mut stream,
        "agent-that-never-registers",
        "agent-that-never-registers:missing-session",
        Duration::from_millis(450),
        "not started (negative fixture)",
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(
        error.contains("session discovery deadline exceeded"),
        "{error}"
    );
    assert!(
        error.contains("agent-that-never-registers:missing-session"),
        "{error}"
    );
    assert!(error.contains("observed_sessions=[]"), "{error}");
    assert!(error.contains("last_response="), "{error}");
    // A saturated CI runner may exhaust the short negative budget while
    // fetching agent.list. Both "not registered" and a bounded diagnostic
    // timeout are valid; the negative fixture must not introduce a new flake.
    assert!(error.contains("agent_registration="), "{error}");
    assert!(error.contains("watcher_state=not started"), "{error}");
    handle.abort();
}

/// Read relay frames until one carries `want`, skipping everything else.
///
/// Separate from [`send_and_recv`] because this one is looking for an
/// **unsolicited** frame: an acknowledgement is a notification with no request
/// to pair against, so there is no id to match — only the wire name.
async fn await_wire(
    stream: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    want: &str,
) -> Option<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                if parsed.get("msg_type").and_then(serde_json::Value::as_str) == Some(want) {
                    return Some(parsed);
                }
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(_))) | Ok(None) => return None,
            Err(_) => continue,
        }
    }
    None
}

// ============================================================================
// Relay Mode Integration Tests
// ============================================================================

#[tokio::test]
async fn relay_attach_and_terminal_io() {
    let session_name = unique_session_name("relay-io");

    // Pre-clean tmux session from previous crashed run.
    SessionManager::new().kill_session(&session_name).await.ok();

    // 1. Start server and agent.
    let (server_addr, server_handle, _db_dir) = start_server("test-token").await.unwrap();
    let (agent_addr, agent_handle, agent_credentials, agent_mutations) =
        start_agent("relay-test-agent").await.unwrap();

    // 2. Create a tmux session.
    let tmux = SessionManager::new();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .expect("create tmux session");

    // 3. Register agent with server so it's Online.
    let client_handle = register_agent(
        server_addr,
        "relay-test-agent",
        "test-token",
        agent_addr.port(),
        Arc::clone(&agent_credentials),
        // The listener's own lane, so this test really does exercise one agent
        // with two mutating paths rather than two agents' worth of wiring.
        Arc::clone(&agent_mutations),
    )
    .await
    .unwrap();

    // 3b. Start heartbeat loop so the server keeps the agent Online.
    let heartbeat = HeartbeatLoop::new(
        client_handle.clone(),
        Arc::new(SessionManager::new()),
        1, // 1s interval for fast test
    );
    let heartbeat_shutdown = heartbeat.shutdown_handle();
    tokio::spawn(async move {
        let _ = heartbeat.run().await;
    });

    // 3c. Start session watcher so the tmux session syncs to the server.
    let watcher = SessionWatcher::new(
        client_handle.clone(),
        Arc::new(SessionManager::new()),
        1, // 1s poll for fast test
    );
    let watcher_shutdown = watcher.shutdown_handle();
    tokio::spawn(async move {
        let _ = watcher.run().await;
    });

    // Readiness is checked against the exact registry identity after browser auth.

    // 4. Connect a "browser" client to the server.
    let url = format!("ws://{server_addr}");
    let (ws, _) = connect_async(&url).await.expect("client connect");
    let (mut sink, mut stream) = ws.split();

    // 5. Authenticate.
    let auth_req = msg(
        "server.auth",
        "auth-1",
        serde_json::json!({
            "auth_token": "test-token",
        }),
    );
    let auth_resp = send_and_recv(&mut sink, &mut stream, &auth_req)
        .await
        .unwrap();
    assert_eq!(
        auth_resp["payload"]["status"], "success",
        "auth failed: {auth_resp}"
    );

    // 6. Phase 1: query relay — returns addresses + session_name,
    //    but does NOT enter relay forwarding.
    let session_id = format!("relay-test-agent:{session_name}");
    wait_for_discovered_session(
        &mut sink,
        &mut stream,
        "relay-test-agent",
        &session_id,
        Duration::from_secs(20),
        "started (1s session watcher polling)",
    )
    .await
    .expect("target tmux session must be visible in server discovery before relay attach");
    let attach_req = msg(
        "server.session.attach",
        "attach-1",
        serde_json::json!({
            "session_id": session_id,
            "preferred_mode": "relay",
        }),
    );
    let attach_resp = send_and_recv(&mut sink, &mut stream, &attach_req)
        .await
        .unwrap();
    assert_eq!(
        attach_resp["payload"]["status"], "success",
        "attach failed: {attach_resp}"
    );
    assert_eq!(attach_resp["payload"]["mode"], "relay");
    assert_eq!(attach_resp["payload"]["session_name"], session_name);

    // 7. Phase 2: begin relay — actually enters relay forwarding.
    //    The Terminal is now "mounted" and subscribed to terminal.output.
    let begin_req = msg(
        "server.session.relay.begin",
        "begin-1",
        serde_json::json!({ "session_id": session_id }),
    );
    sink.send(WsMessage::Text(begin_req.to_string()))
        .await
        .expect("send begin");

    // Send terminal.input immediately after relay.begin — macOS PTY writes fail
    // with EIO when the agent attach subprocess idles too long before input.
    let input_data = base64::engine::general_purpose::STANDARD.encode(b"echo RELAY_TEST_MARKER\n");
    let input_msg = msg(
        "agent.terminal.input",
        "input-1",
        serde_json::json!({
            "session_name": session_name,
            "data": input_data,
        }),
    );
    sink.send(WsMessage::Text(input_msg.to_string()))
        .await
        .expect("send terminal.input");

    // 9. Wait for terminal.output containing the marker.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut got_output = false;
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                let msg_type = parsed["msg_type"].as_str().unwrap_or("");
                if msg_type == "agent.terminal.output" {
                    let b64 = parsed["payload"]["data"].as_str().unwrap_or("");
                    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(b64) {
                        let output = String::from_utf8_lossy(&decoded);
                        if output.contains("RELAY_TEST_MARKER") {
                            got_output = true;
                            break;
                        }
                    }
                } else if msg_type == "error" {
                    panic!(
                        "relay error: {}",
                        parsed["payload"]["message"].as_str().unwrap_or("unknown")
                    );
                }
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => {
                eprintln!("WS error while reading output: {e}");
                break;
            }
            Ok(None) => {
                eprintln!("WS stream closed while waiting for output");
                break;
            }
            Err(_) => continue, // timeout, try again
        }
    }

    // 10. Clean up.
    heartbeat_shutdown.shutdown().await.ok();
    watcher_shutdown.shutdown().await.ok();
    tmux.kill_session(&session_name).await.ok();
    client_handle.shutdown().await.ok();
    agent_handle.shutdown().await.ok();
    server_handle.abort();

    assert!(
        got_output,
        "expected terminal.output containing 'RELAY_TEST_MARKER'"
    );
}

/// #1307 SC-13: the relay carries the agent's input acknowledgement back to
/// the browser.
///
/// The requirement's brief says to *check* this rather than assume it, and the
/// answer is not visible from either side alone: `notify_input_ack` sends the
/// notification to every `SessionPeer`, and the relay's `agent.attach`
/// connection is one; the Server's agent→client loop forwards every agent frame
/// through `send_terminal` with no `msg_type` filter. Both halves had to be
/// measured together, because a client whose queue never drains is a client
/// that re-sends everything it ever typed until the TTL throws it away.
///
/// The epoch is deliberately wrong on the first frame. `next_epoch()` is seeded
/// from wall-clock **microseconds** (~1.79e15), so a frame naming epoch 1 can
/// never be that session's run — the agent refuses it, writes nothing, and
/// answers with its real epoch and a cursor still at 0. That reply is the
/// measurement: it proves the frame reached the agent *and* that the answer
/// came back. The second frame uses the epoch the first one revealed, so it is
/// applied, and the cursor reaching 1 is what says the bytes reached the PTY.
#[tokio::test]
async fn relay_carries_the_input_ack_to_the_browser() {
    let session_name = unique_session_name("relay-ack");

    SessionManager::new().kill_session(&session_name).await.ok();

    let (server_addr, server_handle, _db_dir) = start_server("test-token").await.unwrap();
    let (agent_addr, agent_handle, agent_credentials, agent_mutations) =
        start_agent("relay-ack-agent").await.unwrap();

    let tmux = SessionManager::new();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .expect("create tmux session");

    let client_handle = register_agent(
        server_addr,
        "relay-ack-agent",
        "test-token",
        agent_addr.port(),
        Arc::clone(&agent_credentials),
        Arc::clone(&agent_mutations),
    )
    .await
    .unwrap();

    let heartbeat = HeartbeatLoop::new(client_handle.clone(), Arc::new(SessionManager::new()), 1);
    let heartbeat_shutdown = heartbeat.shutdown_handle();
    tokio::spawn(async move {
        let _ = heartbeat.run().await;
    });

    let watcher = SessionWatcher::new(client_handle.clone(), Arc::new(SessionManager::new()), 1);
    let watcher_shutdown = watcher.shutdown_handle();
    tokio::spawn(async move {
        let _ = watcher.run().await;
    });

    // Agent registration and SessionWatcher readiness are checked below.

    let url = format!("ws://{server_addr}");
    let (ws, _) = connect_async(&url).await.expect("client connect");
    let (mut sink, mut stream) = ws.split();

    let auth_req = msg(
        "server.auth",
        "auth-1",
        serde_json::json!({ "auth_token": "test-token" }),
    );
    send_and_recv(&mut sink, &mut stream, &auth_req)
        .await
        .unwrap();

    let session_id = format!("relay-ack-agent:{session_name}");
    wait_for_discovered_session(
        &mut sink,
        &mut stream,
        "relay-ack-agent",
        &session_id,
        Duration::from_secs(20),
        "started (1s session watcher polling)",
    )
    .await
    .expect("target tmux session must be visible in server discovery before relay attach");
    let attach_req = msg(
        "server.session.attach",
        "attach-1",
        serde_json::json!({ "session_id": session_id, "preferred_mode": "relay" }),
    );
    let attach_resp = send_and_recv(&mut sink, &mut stream, &attach_req)
        .await
        .unwrap();
    assert_eq!(
        attach_resp["payload"]["status"], "success",
        "attach failed: {attach_resp}"
    );

    let begin_req = msg(
        "server.session.relay.begin",
        "begin-1",
        serde_json::json!({ "session_id": session_id }),
    );
    sink.send(WsMessage::Text(begin_req.to_string()))
        .await
        .expect("send begin");

    // A frame naming an epoch this session cannot be in. It is refused, and
    // the refusal is still an acknowledgement — the one that tells us what the
    // real epoch is.
    let probe = msg(
        "agent.terminal.input",
        "input-probe",
        serde_json::json!({
            "session_name": session_name,
            "data": base64::engine::general_purpose::STANDARD.encode("echo RELAY_ACK_MARKER\n"),
            "input_epoch": 1,
            "seq_start": 1,
            "seq_end": 1,
        }),
    );
    sink.send(WsMessage::Text(probe.to_string()))
        .await
        .expect("send probe input");

    let refused_ack = await_wire(&mut stream, "agent.terminal.input.ack")
        .await
        .expect("the relay must carry the agent's input acknowledgement to the browser");

    assert_eq!(
        refused_ack["payload"]["session_name"], session_name,
        "the acknowledgement names the session it is about: {refused_ack}"
    );
    assert_eq!(
        refused_ack["payload"]["applied_through"], 0,
        "a frame from another epoch writes nothing, so the cursor does not move: {refused_ack}"
    );
    let epoch = refused_ack["payload"]["input_epoch"]
        .as_u64()
        .expect("the agent states the epoch it is actually in");

    // Now the same bytes at the position the agent just stated.
    let applied = msg(
        "agent.terminal.input",
        "input-1",
        serde_json::json!({
            "session_name": session_name,
            "data": base64::engine::general_purpose::STANDARD.encode("echo RELAY_ACK_MARKER\n"),
            "input_epoch": epoch,
            "seq_start": 1,
            "seq_end": 1,
        }),
    );
    // How long a healthy acknowledgement actually takes, which is the number
    // SC-11's latency claim rests on and had none (#1307 stage 5).
    //
    // The client re-offers **everything above its cursor** on every keystroke —
    // that is the retry, and it is what makes a lost acknowledgement free. So
    // the frame count is `keystrokes x run length`, and the run length is set by
    // how many keystrokes pass before an acknowledgement lands. A sender that
    // types faster than the round trip pays for it quadratically.
    //
    // Measured at the client seam already: 64 keystrokes with the
    // acknowledgement arriving between each produce 64 frames; with none
    // arriving they produce 2080. This is the missing half — the round trip
    // over the real stack, server and agent and PTY included, which is what
    // decides whether "between each" is true.
    //
    // The bound is a rail rather than a budget: it catches the acknowledgement
    // never arriving (which is exactly the relay defect #1307 stage 4 fixed —
    // the frame reached the browser and nothing read it) without failing a slow
    // CI machine. The figure it measured here is what the report cites.
    let started = std::time::Instant::now();
    sink.send(WsMessage::Text(applied.to_string()))
        .await
        .expect("send sequenced input");

    let applied_ack = await_wire(&mut stream, "agent.terminal.input.ack")
        .await
        .expect("the applied frame is acknowledged too");
    let round_trip = started.elapsed();
    eprintln!("measured input-ack round trip (server+agent+PTY): {round_trip:?}");
    assert!(
        round_trip < Duration::from_secs(2),
        "a healthy acknowledgement took {round_trip:?}, which is far past any \
         round trip this stack should have: the client's re-offer would grow \
         with every keystroke typed in the meantime"
    );

    assert_eq!(
        applied_ack["payload"]["input_epoch"], epoch,
        "the acknowledgement is about the run the frame named: {applied_ack}"
    );
    assert_eq!(
        applied_ack["payload"]["applied_through"], 1,
        "ACK means the bytes reached the PTY, and the cursor says so: {applied_ack}"
    );

    heartbeat_shutdown.shutdown().await.ok();
    watcher_shutdown.shutdown().await.ok();
    tmux.kill_session(&session_name).await.ok();
    client_handle.shutdown().await.ok();
    agent_handle.shutdown().await.ok();
    server_handle.abort();
}

/// The identity the Agent knows for a relayed browser is the browser's own
/// (#1429).
///
/// A relay is a dedicated connection to the Agent per browser-session, so the
/// immediate result of an unauthenticated one is not "no identity" — it is
/// `unknown-client`, **the same string for every browser and for the Server
/// itself**. The Web decides its control role by comparing the ids the Agent
/// publishes (`agent.terminal.control.changed`, the acquire reply) against its
/// own stable id, so a relay that never names the browser makes every such
/// comparison false, no matter which browser is behind it.
///
/// The assertion is the browser's own: the controller id the Agent publishes
/// for this session is the id this browser authenticated with. It is read off
/// the acquire reply rather than the notification because the reply is one
/// frame with one id to pair against — `send_and_recv` is the harness that
/// already does that pairing.
///
/// The mutation is dropping the identity from the relay's `client.auth` (or
/// sending no `client.auth` at all): the id becomes `unknown-client` and the
/// comparison the browser makes becomes false.
#[tokio::test]
async fn relay_binds_the_browser_identity_to_the_agent_connection() {
    const BROWSER_ID: &str = "browser-relay-identity-1429";
    let session_name = unique_session_name("relay-identity");

    SessionManager::new().kill_session(&session_name).await.ok();

    let (server_addr, server_handle, _db_dir) = start_server("test-token").await.unwrap();
    let (agent_addr, agent_handle, agent_credentials, agent_mutations) =
        start_agent("relay-identity-agent").await.unwrap();

    let tmux = SessionManager::new();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .expect("create tmux session");

    let client_handle = register_agent(
        server_addr,
        "relay-identity-agent",
        "test-token",
        agent_addr.port(),
        Arc::clone(&agent_credentials),
        Arc::clone(&agent_mutations),
    )
    .await
    .unwrap();

    let heartbeat = HeartbeatLoop::new(client_handle.clone(), Arc::new(SessionManager::new()), 1);
    let heartbeat_shutdown = heartbeat.shutdown_handle();
    tokio::spawn(async move {
        let _ = heartbeat.run().await;
    });

    let watcher = SessionWatcher::new(client_handle.clone(), Arc::new(SessionManager::new()), 1);
    let watcher_shutdown = watcher.shutdown_handle();
    tokio::spawn(async move {
        let _ = watcher.run().await;
    });

    // Agent registration and SessionWatcher readiness are checked below.

    let url = format!("ws://{server_addr}");
    let (ws, _) = connect_async(&url).await.expect("client connect");
    let (mut sink, mut stream) = ws.split();

    // The browser's handshake carries its stable identity — the same field the
    // Web sends from `getOrCreateClientId`. It is what the relay must present
    // to the Agent, so that the Agent's ids are ids the browser can recognise.
    let auth_req = msg(
        "server.auth",
        "auth-1",
        serde_json::json!({
            "auth_token": "test-token",
            "client_id": BROWSER_ID,
        }),
    );
    let auth_resp = send_and_recv(&mut sink, &mut stream, &auth_req)
        .await
        .unwrap();
    assert_eq!(
        auth_resp["payload"]["status"], "success",
        "auth failed: {auth_resp}"
    );

    let session_id = format!("relay-identity-agent:{session_name}");
    wait_for_discovered_session(
        &mut sink,
        &mut stream,
        "relay-identity-agent",
        &session_id,
        Duration::from_secs(20),
        "started (1s session watcher polling)",
    )
    .await
    .expect("target tmux session must be visible in server discovery before relay attach");
    let attach_req = msg(
        "server.session.attach",
        "attach-1",
        serde_json::json!({ "session_id": session_id, "preferred_mode": "relay" }),
    );
    let attach_resp = send_and_recv(&mut sink, &mut stream, &attach_req)
        .await
        .unwrap();
    assert_eq!(
        attach_resp["payload"]["status"], "success",
        "attach failed: {attach_resp}"
    );

    let begin_req = msg(
        "server.session.relay.begin",
        "begin-1",
        serde_json::json!({ "session_id": session_id }),
    );
    sink.send(WsMessage::Text(begin_req.to_string()))
        .await
        .expect("send begin");

    // Acquire is forwarded verbatim like any other browser frame, and the
    // Agent's reply states the controller it now has.
    let acquire = msg(
        "agent.terminal.control.acquire",
        "acquire-1",
        serde_json::json!({ "session_name": session_name }),
    );
    let acquired = send_and_recv(&mut sink, &mut stream, &acquire)
        .await
        .expect("the acquire must be answered through the relay");

    assert_eq!(
        acquired["payload"]["controller_client_id"].as_str(),
        Some(BROWSER_ID),
        "the Agent must know this browser by its own id, not by a shared \
         placeholder: {acquired}"
    );
    assert_eq!(
        acquired["payload"]["role"].as_str(),
        Some("controller"),
        "and the client that holds it is told so: {acquired}"
    );

    // A second browser on the same session, which presents no id of its own —
    // the shape an older client has. It must still be *somebody*: the Server's
    // per-attach id stands in, so two relays never collapse into one identity
    // and the Agent never sees the shared placeholder.
    let (ws_b, _) = connect_async(&url).await.expect("second client connect");
    let (mut sink_b, mut stream_b) = ws_b.split();
    let auth_b = msg(
        "server.auth",
        "auth-2",
        serde_json::json!({ "auth_token": "test-token" }),
    );
    send_and_recv(&mut sink_b, &mut stream_b, &auth_b)
        .await
        .unwrap();
    let attach_b = msg(
        "server.session.attach",
        "attach-2",
        serde_json::json!({ "session_id": session_id, "preferred_mode": "relay" }),
    );
    send_and_recv(&mut sink_b, &mut stream_b, &attach_b)
        .await
        .unwrap();
    let begin_b = msg(
        "server.session.relay.begin",
        "begin-2",
        serde_json::json!({ "session_id": session_id }),
    );
    sink_b
        .send(WsMessage::Text(begin_b.to_string()))
        .await
        .expect("send begin for the second browser");

    let acquire_b = msg(
        "agent.terminal.control.acquire",
        "acquire-2",
        serde_json::json!({ "session_name": session_name }),
    );
    let acquired_b = send_and_recv(&mut sink_b, &mut stream_b, &acquire_b)
        .await
        .expect("the second acquire must be answered too");
    let id_b = acquired_b["payload"]["controller_client_id"].as_str();
    assert_ne!(
        id_b,
        Some("unknown-client"),
        "a client that presented no id still gets one of its own: {acquired_b}"
    );
    assert_ne!(
        id_b,
        Some(BROWSER_ID),
        "and it is not the other browser's: {acquired_b}"
    );

    heartbeat_shutdown.shutdown().await.ok();
    watcher_shutdown.shutdown().await.ok();
    tmux.kill_session(&session_name).await.ok();
    client_handle.shutdown().await.ok();
    agent_handle.shutdown().await.ok();
    server_handle.abort();
}

/// #2060 SC-02 / #2120 SC-02: the **real** Agent admits a parser-applied ACK
/// only from the exact Relay peer and subscription it minted.
///
/// The mock-tunnel test proves the Server forwards the wire; this one runs the
/// whole chain the product runs — browser → Server relay → real Agent → tmux —
/// and reads the Agent's own verdict back through the same tunnel.
///
/// Every fact is Agent-authored: the ready receipt carries the subscription
/// generation and stream epoch, the output frame carries the stream position,
/// and the Agent answers each ACK with `ok` or `output_ack_rejected`. The
/// negatives are the point of the test: a foreign generation, a foreign epoch,
/// a second renderer generation after the first pinned it, a regressive
/// cursor, a cursor past the Agent-issued head, and an unsafe JavaScript
/// integer must all be refused, so none of them can release issued credit.
#[tokio::test]
async fn relay_output_applied_ack_is_admitted_only_for_the_agent_minted_subscription() {
    const BROWSER_ID: &str = "browser-relay-parser-ack-2060";
    let session_name = unique_session_name("relay-parser-ack");

    // Pre-clean a tmux session from a previous crashed run.
    SessionManager::new().kill_session(&session_name).await.ok();

    let (server_addr, server_handle, _db_dir) = start_server("test-token").await.unwrap();
    let (agent_addr, agent_handle, agent_credentials, agent_mutations) =
        start_agent("relay-parser-ack-agent").await.unwrap();

    let tmux = SessionManager::new();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .expect("create tmux session");

    let client_handle = register_agent(
        server_addr,
        "relay-parser-ack-agent",
        "test-token",
        agent_addr.port(),
        Arc::clone(&agent_credentials),
        Arc::clone(&agent_mutations),
    )
    .await
    .unwrap();

    let heartbeat = HeartbeatLoop::new(client_handle.clone(), Arc::new(SessionManager::new()), 1);
    let heartbeat_shutdown = heartbeat.shutdown_handle();
    tokio::spawn(async move {
        let _ = heartbeat.run().await;
    });

    let watcher = SessionWatcher::new(client_handle.clone(), Arc::new(SessionManager::new()), 1);
    let watcher_shutdown = watcher.shutdown_handle();
    tokio::spawn(async move {
        let _ = watcher.run().await;
    });

    let (ws, _) = connect_async(format!("ws://{server_addr}"))
        .await
        .expect("client connect");
    let (mut sink, mut stream) = ws.split();

    // The ready receipt is minted only for a browser that authenticated with
    // its own stable id (`authenticated_browser_id`); a legacy browser gets no
    // route proof and must stay on the non-credit lane.
    let auth_req = msg(
        "server.auth",
        "auth-parser-ack",
        serde_json::json!({ "auth_token": "test-token", "client_id": BROWSER_ID }),
    );
    let auth_resp = send_and_recv(&mut sink, &mut stream, &auth_req)
        .await
        .unwrap();
    assert_eq!(
        auth_resp["payload"]["status"], "success",
        "auth failed: {auth_resp}"
    );

    let session_id = format!("relay-parser-ack-agent:{session_name}");
    wait_for_discovered_session(
        &mut sink,
        &mut stream,
        "relay-parser-ack-agent",
        &session_id,
        Duration::from_secs(20),
        "started (1s session watcher polling)",
    )
    .await
    .expect("target tmux session must be visible in server discovery before relay attach");

    let attach_req = msg(
        "server.session.attach",
        "attach-parser-ack",
        serde_json::json!({ "session_id": session_id, "preferred_mode": "relay" }),
    );
    let attach_resp = send_and_recv(&mut sink, &mut stream, &attach_req)
        .await
        .unwrap();
    assert_eq!(
        attach_resp["payload"]["status"], "success",
        "attach failed: {attach_resp}"
    );

    let begin_req = msg(
        "server.session.relay.begin",
        "begin-parser-ack",
        serde_json::json!({ "session_id": session_id }),
    );
    sink.send(WsMessage::Text(begin_req.to_string()))
        .await
        .expect("send begin");

    // One known Agent output event. Sent immediately after begin for the same
    // reason as the input-ack test: the Plain PTY attach subprocess fails with
    // EIO when it idles too long before the first write.
    let input_msg = msg(
        "agent.terminal.input",
        "input-parser-ack",
        serde_json::json!({
            "session_name": session_name,
            "data": base64::engine::general_purpose::STANDARD
                .encode("echo RELAY_PARSER_ACK_MARKER\n"),
        }),
    );
    sink.send(WsMessage::Text(input_msg.to_string()))
        .await
        .expect("send terminal.input");

    // Collect the two Agent-authored facts. Their relative order is not part
    // of the contract: the attach reply is answered before a stream position
    // exists, output can arrive while the receipt is still in flight.
    let mut proof: Option<serde_json::Value> = None;
    let mut positioned: Option<serde_json::Value> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while (proof.is_none() || positioned.is_none()) && tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                match parsed["msg_type"].as_str().unwrap_or("") {
                    "server.session.relay.ready" => proof = Some(parsed),
                    "agent.terminal.output" => {
                        if parsed["payload"]["stream_epoch"].is_u64()
                            && parsed["payload"]["stream_seq"].is_u64()
                        {
                            positioned = Some(parsed);
                        }
                    }
                    "error" => panic!("relay error while waiting for proof/output: {parsed}"),
                    _ => {}
                }
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => panic!("WS error: {e}"),
            Ok(None) => panic!("WS stream closed before proof and output arrived"),
            Err(_) => continue,
        }
    }
    let proof = proof.expect("the Agent-authored relay ready proof must reach the browser");
    let positioned = positioned.expect("a positioned Agent output event must reach the browser");

    let generation = proof["payload"]["subscriber_generation"]
        .as_u64()
        .expect("ready proof must carry the Agent-minted subscriber generation");
    let epoch = proof["payload"]["stream_epoch"]
        .as_u64()
        .expect("ready proof must carry the Agent stream epoch");
    assert_eq!(
        proof["payload"]["browser_client_id"], BROWSER_ID,
        "the receipt must be scoped to this browser: {proof}"
    );
    assert_eq!(proof["payload"]["relay_request_id"], "begin-parser-ack");
    assert_eq!(proof["payload"]["session_name"], session_name);
    assert_eq!(
        positioned["payload"]["stream_epoch"].as_u64(),
        Some(epoch),
        "Relay must carry the same Agent stream epoch the proof named: {positioned}"
    );
    let applied = positioned["payload"]["stream_seq"]
        .as_u64()
        .expect("positioned output must carry a stream seq");
    assert!(applied > 0, "a positioned output event starts at seq 1");

    let ack = |id: &str, generation: u64, epoch: u64, renderer: u64, through: u64| {
        msg(
            "agent.terminal.output.applied",
            id,
            serde_json::json!({
                "session_name": session_name,
                "subscriber_generation": generation,
                "stream_epoch": epoch,
                "renderer_generation": renderer,
                "applied_through": through,
            }),
        )
    };
    let rejected = |reply: &serde_json::Value| {
        reply["msg_type"] == "error" && reply["payload"]["code"] == "output_ack_rejected"
    };

    // The exact peer, subscription, epoch, renderer and contiguous prefix.
    let ok = send_and_recv(
        &mut sink,
        &mut stream,
        &ack("ack-valid", generation, epoch, 1, applied),
    )
    .await
    .unwrap();
    assert_eq!(
        ok["msg_type"], "ok",
        "the real Agent must admit the exact parser-applied prefix: {ok}"
    );

    // The same position again is idempotent credit, not a second release.
    let duplicate = send_and_recv(
        &mut sink,
        &mut stream,
        &ack("ack-duplicate", generation, epoch, 1, applied),
    )
    .await
    .unwrap();
    assert_eq!(
        duplicate["msg_type"], "ok",
        "a duplicate parser position is acknowledged without advancing: {duplicate}"
    );

    // A generation the Agent did not mint for this peer.
    let wrong_generation = send_and_recv(
        &mut sink,
        &mut stream,
        &ack("ack-wrong-generation", generation + 1, epoch, 1, applied),
    )
    .await
    .unwrap();
    assert!(
        rejected(&wrong_generation),
        "a foreign subscriber generation must not release credit: {wrong_generation}"
    );

    // The right subscription, a foreign stream timeline.
    let wrong_epoch = send_and_recv(
        &mut sink,
        &mut stream,
        &ack("ack-wrong-epoch", generation, epoch + 1, 1, applied),
    )
    .await
    .unwrap();
    assert!(
        rejected(&wrong_epoch),
        "a foreign stream epoch must not release credit: {wrong_epoch}"
    );

    // The first advancing ACK pinned renderer 1; a remount needs a new
    // subscription, not a second renderer on this one.
    let stale_renderer = send_and_recv(
        &mut sink,
        &mut stream,
        &ack("ack-stale-renderer", generation, epoch, 2, applied),
    )
    .await
    .unwrap();
    assert!(
        rejected(&stale_renderer),
        "a new renderer generation cannot advance the pinned subscription: {stale_renderer}"
    );

    // Past the Agent-issued frontier: no credit exists for bytes it never sent.
    let beyond_issued = send_and_recv(
        &mut sink,
        &mut stream,
        &ack(
            "ack-beyond-issued",
            generation,
            epoch,
            1,
            applied + 1_000_000,
        ),
    )
    .await
    .unwrap();
    assert!(
        rejected(&beyond_issued),
        "an ACK past the issued head must not release credit: {beyond_issued}"
    );

    // A cursor that walks backwards cannot re-release a credited prefix.
    let regressive = send_and_recv(
        &mut sink,
        &mut stream,
        &ack(
            "ack-regressive",
            generation,
            epoch,
            1,
            applied.saturating_sub(1),
        ),
    )
    .await
    .unwrap();
    assert!(
        rejected(&regressive),
        "a regressive parser cursor must not release credit: {regressive}"
    );

    // JavaScript cannot round-trip this integer, so it is not a position.
    let unsafe_integer = send_and_recv(
        &mut sink,
        &mut stream,
        &ack("ack-unsafe", generation, epoch, 1, 1_u64 << 53),
    )
    .await
    .unwrap();
    assert!(
        rejected(&unsafe_integer),
        "an unsafe wire integer must not release credit: {unsafe_integer}"
    );

    heartbeat_shutdown.shutdown().await.ok();
    watcher_shutdown.shutdown().await.ok();
    tmux.kill_session(&session_name).await.ok();
    client_handle.shutdown().await.ok();
    agent_handle.shutdown().await.ok();
    server_handle.abort();
}

// ---------------------------------------------------------------------------
// #2126: one Agent timeline, observed through both routes
// ---------------------------------------------------------------------------

type ParityStream = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;

#[derive(Default)]
struct RouteObservations {
    /// (stream epoch, stream seq, decoded text) for positioned output.
    outputs: Vec<(u64, u64, String)>,
    /// (stream epoch, stream seq) of authoritative resizes.
    resizes: Vec<(u64, u64)>,
}

fn marker_event<'a>(
    observations: &'a RouteObservations,
    marker: &str,
) -> Option<&'a (u64, u64, String)> {
    observations
        .outputs
        .iter()
        .find(|(_, _, text)| text.contains(marker))
}

/// Read one route until `done`, recording Agent positions. Frames without a
/// position (legacy output, bootstraps) cannot be compared and are skipped.
async fn collect_route(
    stream: &mut ParityStream,
    deadline: tokio::time::Instant,
    done: impl Fn(&RouteObservations) -> bool,
) -> anyhow::Result<RouteObservations> {
    let mut observations = RouteObservations::default();
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let frame: serde_json::Value = serde_json::from_str(&text)?;
                let msg_type = frame
                    .get("msg_type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let payload = frame.get("payload");
                match msg_type {
                    "agent.terminal.output" => {
                        let Some(payload) = payload else { continue };
                        // A bootstrap is history, not an event in the stream.
                        if payload.get("bootstrap").is_some() {
                            continue;
                        }
                        if let (Some(epoch), Some(seq)) = (
                            payload
                                .get("stream_epoch")
                                .and_then(serde_json::Value::as_u64),
                            payload
                                .get("stream_seq")
                                .and_then(serde_json::Value::as_u64),
                        ) {
                            let bytes = base64::engine::general_purpose::STANDARD
                                .decode(
                                    payload
                                        .get("data")
                                        .and_then(serde_json::Value::as_str)
                                        .unwrap_or(""),
                                )
                                .unwrap_or_default();
                            observations.outputs.push((
                                epoch,
                                seq,
                                String::from_utf8_lossy(&bytes).to_string(),
                            ));
                        }
                    }
                    "agent.terminal.resize" => {
                        let payload = payload.unwrap_or(&serde_json::Value::Null);
                        if let (Some(epoch), Some(seq)) = (
                            payload
                                .get("stream_epoch")
                                .and_then(serde_json::Value::as_u64),
                            payload
                                .get("stream_seq")
                                .and_then(serde_json::Value::as_u64),
                        ) {
                            observations.resizes.push((epoch, seq));
                        }
                    }
                    "error" => anyhow::bail!("route error while observing: {frame}"),
                    _ => {}
                }
                if done(&observations) {
                    return Ok(observations);
                }
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(None) => anyhow::bail!("route closed before the expected event"),
            Err(_) => continue,
        }
    }
    Ok(observations)
}

/// #2126 SC-01/SC-02: a direct P2P subscriber and a Server-Relay subscriber on
/// the same Session observe one Agent-assigned timeline.
///
/// The two routes are genuinely distinct: the P2P client dials the Agent's own
/// WebSocket, while the Relay client dials the Server, which opens its own
/// authenticated Agent socket and forwards frames. Both must report the same
/// `(streamEpoch, streamSeq)` and the same bytes for the same output event, and
/// one authoritative resize must consume the same shared ordinal on both.
///
/// A Server that renumbered, minted a second sequence, or rewrote the frame
/// would fail the position equality; a route that dropped or reordered the
/// shared ordinal would fail the output → resize → output assertion.
#[tokio::test]
async fn p2p_and_relay_observe_one_agent_stream_timeline() -> anyhow::Result<()> {
    const AGENT_ID: &str = "route-parity-agent";
    const P2P_ID: &str = "p2p-parity-browser";
    const RELAY_ID: &str = "relay-parity-browser";
    const MARKER: &str = "ROUTE-PARITY-MARKER-2126";
    const AFTER: &str = "ROUTE-PARITY-AFTER-2126";

    let session_name = unique_session_name("route-parity");
    SessionManager::new().kill_session(&session_name).await.ok();

    let (server_addr, server_handle, _db_dir) = start_server("test-token").await?;
    let (agent_addr, agent_handle, agent_credentials, agent_mutations) =
        start_agent(AGENT_ID).await?;

    let tmux = SessionManager::new();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await?;

    let client_handle = register_agent(
        server_addr,
        AGENT_ID,
        "test-token",
        agent_addr.port(),
        Arc::clone(&agent_credentials),
        Arc::clone(&agent_mutations),
    )
    .await?;

    let heartbeat = HeartbeatLoop::new(client_handle.clone(), Arc::new(SessionManager::new()), 1);
    let heartbeat_shutdown = heartbeat.shutdown_handle();
    tokio::spawn(async move {
        let _ = heartbeat.run().await;
    });
    let watcher = SessionWatcher::new(client_handle.clone(), Arc::new(SessionManager::new()), 1);
    let watcher_shutdown = watcher.shutdown_handle();
    tokio::spawn(async move {
        let _ = watcher.run().await;
    });

    // ── Direct P2P subscriber ────────────────────────────────────────────
    let credential = format!("route-parity-credential-{session_name}");
    let grant = P2pGrantPayload {
        request_id: "route-parity".to_string(),
        credential: credential.clone(),
        agent_id: AGENT_ID.to_string(),
        session_id: format!("{AGENT_ID}:{session_name}"),
        scope: CredentialScope::for_attach(&session_name),
        expires_at: "2999-01-01T00:00:00Z".to_string(),
    };
    agent_credentials
        .grant(AGENT_ID, &grant)
        .map_err(|refusal| anyhow::anyhow!("agent refused the test grant: {refusal:?}"))?;
    let p2p_url = agent_url_with_credential(&format!("ws://{agent_addr}"), &credential);
    let (p2p_ws, _) = connect_async(&p2p_url).await?;
    let (mut p2p_sink, mut p2p_stream) = p2p_ws.split();

    let auth = msg(
        "client.auth",
        "p2p-auth",
        serde_json::json!({ "auth_token": "", "client_id": P2P_ID }),
    );
    let reply = send_and_recv(&mut p2p_sink, &mut p2p_stream, &auth).await?;
    anyhow::ensure!(reply["msg_type"] == "ok", "p2p auth failed: {reply}");

    let attach = msg(
        "agent.attach",
        "p2p-attach",
        serde_json::json!({
            "session_name": session_name,
            "width": 80,
            "height": 24,
            "size_known": null,
            "env_snapshots": [],
            "needs_bootstrap": true,
        }),
    );
    let attached = send_and_recv(&mut p2p_sink, &mut p2p_stream, &attach).await?;
    anyhow::ensure!(
        attached["msg_type"] == "ok",
        "p2p attach failed: {attached}"
    );
    let p2p_epoch = attached["payload"]["stream_epoch"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("p2p attach did not state a stream epoch: {attached}"))?;

    // ── Relay subscriber through the Server ──────────────────────────────
    let (relay_ws, _) = connect_async(format!("ws://{server_addr}")).await?;
    let (mut relay_sink, mut relay_stream) = relay_ws.split();
    let auth = msg(
        "server.auth",
        "relay-auth",
        serde_json::json!({ "auth_token": "test-token", "client_id": RELAY_ID }),
    );
    let reply = send_and_recv(&mut relay_sink, &mut relay_stream, &auth).await?;
    anyhow::ensure!(
        reply["payload"]["status"] == "success",
        "relay auth failed: {reply}"
    );

    let session_id = format!("{AGENT_ID}:{session_name}");
    wait_for_discovered_session(
        &mut relay_sink,
        &mut relay_stream,
        AGENT_ID,
        &session_id,
        Duration::from_secs(20),
        "started (1s session watcher polling)",
    )
    .await?;

    let attach = msg(
        "server.session.attach",
        "relay-attach",
        serde_json::json!({ "session_id": session_id, "preferred_mode": "relay" }),
    );
    let reply = send_and_recv(&mut relay_sink, &mut relay_stream, &attach).await?;
    anyhow::ensure!(
        reply["payload"]["status"] == "success",
        "relay attach failed: {reply}"
    );

    let begin = msg(
        "server.session.relay.begin",
        "relay-begin",
        serde_json::json!({ "session_id": session_id }),
    );
    relay_sink.send(WsMessage::Text(begin.to_string())).await?;
    let proof = await_wire(&mut relay_stream, "server.session.relay.ready")
        .await
        .ok_or_else(|| anyhow::anyhow!("relay ready receipt did not arrive"))?;
    let relay_epoch = proof["payload"]["stream_epoch"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("relay receipt did not state a stream epoch: {proof}"))?;
    anyhow::ensure!(
        relay_epoch == p2p_epoch,
        "routes disagree on the session stream epoch: p2p={p2p_epoch} relay={relay_epoch}"
    );

    // Output produced only after both routes are subscribed.
    let input = msg(
        "agent.terminal.input",
        "parity-input",
        serde_json::json!({
            "session_name": session_name,
            "data": base64::engine::general_purpose::STANDARD
                .encode(format!("echo {MARKER}\n")),
        }),
    );
    p2p_sink.send(WsMessage::Text(input.to_string())).await?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let p2p_obs = collect_route(&mut p2p_stream, deadline, |o| {
        marker_event(o, MARKER).is_some()
    })
    .await?;
    let relay_obs = collect_route(&mut relay_stream, deadline, |o| {
        marker_event(o, MARKER).is_some()
    })
    .await?;
    let p2p_marker = marker_event(&p2p_obs, MARKER).expect("p2p never saw the marker");
    let relay_marker = marker_event(&relay_obs, MARKER).expect("relay never saw the marker");
    anyhow::ensure!(
        (p2p_marker.0, p2p_marker.1) == (relay_marker.0, relay_marker.1),
        "routes disagree on the same output event's Agent position: \
         p2p={:?} relay={:?}",
        (p2p_marker.0, p2p_marker.1),
        (relay_marker.0, relay_marker.1)
    );
    anyhow::ensure!(
        p2p_marker.2 == relay_marker.2,
        "routes delivered different bytes for the same Agent event"
    );

    // Every ordinal both routes saw carries identical bytes: the Server
    // neither renumbers nor rewrites what the Agent assigned.
    for (epoch, seq, text) in &p2p_obs.outputs {
        if let Some((_, _, relay_text)) = relay_obs
            .outputs
            .iter()
            .find(|(seen_epoch, seen_seq, _)| seen_epoch == epoch && seen_seq == seq)
        {
            anyhow::ensure!(
                relay_text == text,
                "seq {seq} differs across routes: p2p vs relay"
            );
        }
    }

    // ── One authoritative resize, one shared ordinal ─────────────────────
    let resize = msg(
        "agent.terminal.resize",
        "parity-resize",
        serde_json::json!({ "session_name": session_name, "cols": 100, "rows": 30 }),
    );
    p2p_sink.send(WsMessage::Text(resize.to_string())).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let p2p_obs = collect_route(&mut p2p_stream, deadline, |o| !o.resizes.is_empty()).await?;
    let relay_obs = collect_route(&mut relay_stream, deadline, |o| !o.resizes.is_empty()).await?;
    let p2p_resize = p2p_obs
        .resizes
        .first()
        .copied()
        .expect("p2p never saw the recorded resize");
    let relay_resize = relay_obs
        .resizes
        .first()
        .copied()
        .expect("relay never saw the recorded resize");
    anyhow::ensure!(
        p2p_resize == relay_resize,
        "routes disagree on the resize's Agent position: p2p={p2p_resize:?} relay={relay_resize:?}"
    );
    anyhow::ensure!(
        p2p_resize.1 > p2p_marker.1,
        "the resize must be ordered after the preceding output"
    );

    // Output after the resize advances past its ordinal on both routes.
    let input = msg(
        "agent.terminal.input",
        "parity-after",
        serde_json::json!({
            "session_name": session_name,
            "data": base64::engine::general_purpose::STANDARD
                .encode(format!("echo {AFTER}\n")),
        }),
    );
    p2p_sink.send(WsMessage::Text(input.to_string())).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let p2p_obs = collect_route(&mut p2p_stream, deadline, |o| {
        marker_event(o, AFTER).is_some()
    })
    .await?;
    let relay_obs = collect_route(&mut relay_stream, deadline, |o| {
        marker_event(o, AFTER).is_some()
    })
    .await?;
    let p2p_after = marker_event(&p2p_obs, AFTER).expect("p2p never saw the post-resize output");
    let relay_after =
        marker_event(&relay_obs, AFTER).expect("relay never saw the post-resize output");
    anyhow::ensure!(
        (p2p_after.0, p2p_after.1) == (relay_after.0, relay_after.1),
        "routes disagree on the post-resize event position: p2p={:?} relay={:?}",
        (p2p_after.0, p2p_after.1),
        (relay_after.0, relay_after.1)
    );
    anyhow::ensure!(
        p2p_after.1 > p2p_resize.1,
        "output after the resize must advance past its ordinal"
    );

    heartbeat_shutdown.shutdown().await.ok();
    watcher_shutdown.shutdown().await.ok();
    tmux.kill_session(&session_name).await.ok();
    client_handle.shutdown().await.ok();
    agent_handle.shutdown().await.ok();
    server_handle.abort();
    Ok(())
}
