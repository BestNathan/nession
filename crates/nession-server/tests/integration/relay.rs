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
            memory_threshold_percent: None,
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
        SessionManager::new(),
        1, // 1s interval for fast test
    );
    let heartbeat_shutdown = heartbeat.shutdown_handle();
    tokio::spawn(async move {
        let _ = heartbeat.run().await;
    });

    // 3c. Start session watcher so the tmux session syncs to the server.
    let watcher = SessionWatcher::new(
        client_handle.clone(),
        SessionManager::new(),
        1, // 1s poll for fast test
    );
    let watcher_shutdown = watcher.shutdown_handle();
    tokio::spawn(async move {
        let _ = watcher.run().await;
    });

    // Give heartbeat + session sync time to propagate.
    tokio::time::sleep(Duration::from_millis(2000)).await;

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

    let heartbeat = HeartbeatLoop::new(client_handle.clone(), SessionManager::new(), 1);
    let heartbeat_shutdown = heartbeat.shutdown_handle();
    tokio::spawn(async move {
        let _ = heartbeat.run().await;
    });

    let watcher = SessionWatcher::new(client_handle.clone(), SessionManager::new(), 1);
    let watcher_shutdown = watcher.shutdown_handle();
    tokio::spawn(async move {
        let _ = watcher.run().await;
    });

    tokio::time::sleep(Duration::from_millis(2000)).await;

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

    let heartbeat = HeartbeatLoop::new(client_handle.clone(), SessionManager::new(), 1);
    let heartbeat_shutdown = heartbeat.shutdown_handle();
    tokio::spawn(async move {
        let _ = heartbeat.run().await;
    });

    let watcher = SessionWatcher::new(client_handle.clone(), SessionManager::new(), 1);
    let watcher_shutdown = watcher.shutdown_handle();
    tokio::spawn(async move {
        let _ = watcher.run().await;
    });

    tokio::time::sleep(Duration::from_millis(2000)).await;

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
