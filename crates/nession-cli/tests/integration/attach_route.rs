//! #2811 — CLI attach route selection: advertised P2P candidates, then relay.
//!
//! The CLI default used to read only the legacy single `agent_address`, dial it
//! once, and give up. These tests own the route policy at its observable
//! boundary: a real Server, a real Agent listener and (for the relay cases) a
//! deterministic middlebox that refuses direct dials before forwarding the
//! Server's relay dial.
//!
//! The Agent and tmux are only touched when `NESSION_TMUX_SOCKET` names a
//! harness socket, the same rule the Agent's own tmux tests follow: the default
//! socket belongs to a developer's live agent, not to a test run.

// Helpers here are test infrastructure. `clippy.toml` already allows
// `expect`/`unwrap`/indexing in tests (owner decision of 2026-08-21); Clippy's
// `#[test]`-only heuristic does not classify helper functions as tests, so the
// same owner-approved policy is stated for this module rather than contorting
// every fixture into `Result` plumbing.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use nession_agent::config::AttachMode as AgentAttachMode;
use nession_agent::connection::ServerClient;
use nession_agent::server::websocket::{AgentServer, AgentServerContext};
use nession_agent::session::metadata::SessionMetadataStore;
use nession_agent::sync::heartbeat::HeartbeatLoop;
use nession_agent::sync::session_watcher::SessionWatcher;
use nession_agent::tmux::manager::SessionManager;
use nession_cli::commands::client::{resolve_attach_route, AttachPolicy};
use nession_client::{ClientConfig, ClientConnection};
use nession_common::config::ServerConfig;
use nession_protocol::contracts::agent::v1::{AgentAddress, AgentMetadata, NetworkType};
use nession_protocol::contracts::session::v1::ServerSessionListReply;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Set by `scripts/tmux-run-socket.sh` / the Acceptance Case. Without it a
/// tmux-backed test would land on the developer's live default socket.
const HARNESS_SOCKET_ENV: &str = "NESSION_TMUX_SOCKET";
const SERVER_TOKEN: &str = "test-token";

fn harness_socket() -> Option<String> {
    std::env::var(HARNESS_SOCKET_ENV).ok()
}

fn tmux_available() -> bool {
    // Through the Agent's chokepoint like every other tmux call; `-V` opens no
    // server, so this is harmless on any socket.
    nession_agent::tmux::cmd::global()
        .std()
        .arg("-V")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn unique_session_name(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("nession-2811-{prefix}-{nanos:016x}")
}

/// A port nothing is listening on. Bound then dropped, so the OS has assigned
/// it and will not hand it to a concurrent listener in this test's window.
fn unused_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind an unused port")
        .local_addr()
        .expect("read the bound port")
        .port()
}

struct TestServer {
    addr: std::net::SocketAddr,
    _db: tempfile::TempDir,
    handle: JoinHandle<()>,
}

impl TestServer {
    async fn start() -> Self {
        let db_dir = tempfile::tempdir().expect("server database directory");
        let db_path = db_dir.path().join("server.db");
        let config = ServerConfig {
            listen_address: "127.0.0.1:0".to_string(),
            tls_cert_path: String::new(),
            tls_key_path: String::new(),
            auth_token: SERVER_TOKEN.to_string(),
            heartbeat_interval_secs: 10,
            heartbeat_timeout_secs: 30,
            db_path: db_path.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let db = nession_server::db::Database::new(&config.db_path)
            .await
            .expect("open the server database");
        let mut server = nession_server::server::WebSocketServer::new(config, Arc::new(db))
            .await
            .expect("start the server");
        let addr = server.local_addr().expect("read the server address");
        let handle = tokio::spawn(async move {
            let _ = server
                .run(nession_common::readiness::Readiness::Unwatched)
                .await;
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        Self {
            addr,
            _db: db_dir,
            handle,
        }
    }

    fn url(&self) -> String {
        format!("ws://{}", self.addr)
    }
}

struct TestAgent {
    addr: std::net::SocketAddr,
    handle: nession_agent::server::ServerHandle,
    credentials: Arc<nession_agent::p2p_credentials::P2pCredentials>,
    mutations: nession_agent::execution::MutationLane,
    _tmp: tempfile::TempDir,
}

impl TestAgent {
    async fn start(agent_id: &str) -> Self {
        let tmp = tempfile::tempdir().expect("agent sandbox directory");
        let (resize, _resize_updates) = nession_agent::server::ResizeReporter::new();
        let credentials = Arc::new(nession_agent::p2p_credentials::P2pCredentials::new());
        let mutations = nession_agent::execution::mutation_scheduler();
        let tmux = Arc::new(SessionManager::new());
        let server = AgentServer::new(
            "127.0.0.1:0",
            agent_id,
            None,
            "/tmp".to_string(),
            tmp.path().to_string_lossy().as_ref(),
            AgentAttachMode::Plain,
            AgentServerContext {
                resize,
                credentials: Arc::clone(&credentials),
                mutations: Arc::clone(&mutations),
                tmux: Arc::clone(&tmux),
                session_metadata: Arc::new(SessionMetadataStore::new(tmux)),
                terminal_cols: nession_common::config::DEFAULT_TERMINAL_COLS,
                handshake_policy: Default::default(),
            },
        )
        .expect("build the agent listener");
        let (handle, addr) = server.start().await.expect("start the agent listener");
        Self {
            addr,
            handle,
            credentials,
            mutations,
            _tmp: tmp,
        }
    }
}

/// Register the Agent with the central Server, carrying the test's advertised
/// addresses unchanged into the attach plan.
async fn register_agent(
    server: &TestServer,
    agent: &TestAgent,
    agent_id: &str,
    addresses: Vec<AgentAddress>,
) -> nession_agent::connection::ServerClientHandle {
    let client = ServerClient::new(
        server.url(),
        SERVER_TOKEN,
        agent_id,
        "test-host",
        "127.0.0.1",
        agent.addr.port(),
        None,
        addresses,
        None,
        AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        },
        Arc::new(SessionManager::new()),
        "/tmp".to_string(),
        Some(Arc::new(
            nession_agent::extension::ExtensionRegistry::new(
                agent_id,
                Vec::new(),
                nession_agent::protocol::served_descriptors().expect("agent protocol descriptors"),
            )
            .expect("agent extension registry"),
        )),
        Arc::clone(&agent.credentials),
        Arc::clone(&agent.mutations),
    );
    client
        .connect_and_run()
        .await
        .expect("register the agent with the server")
        .0
}

struct SyncHandles {
    heartbeat: nession_agent::sync::heartbeat::HeartbeatShutdownHandle,
    watcher: nession_agent::sync::session_watcher::SessionWatcherShutdownHandle,
}

fn start_sync(handle: &nession_agent::connection::ServerClientHandle) -> SyncHandles {
    let heartbeat = HeartbeatLoop::new(handle.clone(), Arc::new(SessionManager::new()), 1);
    let heartbeat_shutdown = heartbeat.shutdown_handle();
    tokio::spawn(async move {
        let _ = heartbeat.run().await;
    });
    let watcher = SessionWatcher::new(handle.clone(), Arc::new(SessionManager::new()), 1);
    let watcher_shutdown = watcher.shutdown_handle();
    tokio::spawn(async move {
        let _ = watcher.run().await;
    });
    SyncHandles {
        heartbeat: heartbeat_shutdown,
        watcher: watcher_shutdown,
    }
}

/// Poll the Server's own registry until it has discovered the tmux session.
async fn wait_for_session(client: &mut ClientConnection, session_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(ServerSessionListReply::Listed(list)) = client.list_sessions(None).await {
            if list.sessions.iter().any(|s| s.session_id == session_id) {
                return;
            }
        }
        assert!(
            Instant::now() < deadline,
            "the Server never discovered session {session_id}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn connect_client(server: &TestServer) -> ClientConnection {
    ClientConnection::connect(ClientConfig::new(server.url(), SERVER_TOKEN))
        .await
        .expect("authenticate with the server")
}

/// Read frames until the Agent answers the attach request with its `ok` reply.
async fn await_attach_ack(
    transport: &mut nession_cli::terminal::raw::WebSocketTransport,
    session_name: &str,
) {
    use nession_cli::terminal::TerminalTransport;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "the Agent never acknowledged attach");
        let text = tokio::time::timeout(remaining, transport.recv_text())
            .await
            .expect("timed out waiting for the Agent's attach acknowledgement")
            .expect("read a terminal frame")
            .expect("the agent transport closed before acknowledging attach");
        let frame: serde_json::Value = serde_json::from_str(&text).expect("protocol frame");
        if frame["msg_type"] == "ok" {
            let named = frame["payload"]["session_name"].as_str();
            assert!(
                named.is_none() || named == Some(session_name),
                "the Agent acknowledged a different session: {frame}"
            );
            return;
        }
        if frame["msg_type"] == "error" {
            panic!("the Agent refused the attach: {frame}");
        }
    }
}

/// Send a shell command through the terminal transport and read its output.
async fn run_terminal_command(
    transport: &mut nession_cli::terminal::raw::WebSocketTransport,
    session_name: &str,
    marker: &str,
) {
    use base64::Engine;
    use nession_cli::terminal::{raw::build_terminal_input_message, TerminalTransport};

    transport
        .send_text(build_terminal_input_message(
            session_name,
            format!("echo {marker}\n").as_bytes(),
        ))
        .await
        .expect("send terminal input");

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "the relay never produced terminal output containing {marker}"
        );
        let text = tokio::time::timeout(remaining, transport.recv_text())
            .await
            .expect("timed out waiting for terminal output")
            .expect("read a terminal frame")
            .expect("the relay closed before producing output");
        let frame: serde_json::Value = serde_json::from_str(&text).expect("protocol frame");
        if frame["msg_type"] != "agent.terminal.output" {
            continue;
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(frame["payload"]["data"].as_str().unwrap_or(""))
            .unwrap_or_default();
        if String::from_utf8_lossy(&decoded).contains(marker) {
            return;
        }
    }
}

/// A TCP middlebox in front of the Agent. It refuses the first `fail_first`
/// connections (the CLI's direct dials) and forwards everything after that
/// (the Server's relay dial). Deterministic because the CLI dials exactly one
/// candidate at a time, in plan order, before asking for the relay.
struct DirectDialRefuser {
    addr: std::net::SocketAddr,
    hits: Arc<AtomicUsize>,
    handle: JoinHandle<()>,
}

async fn refuse_direct_dials(target: std::net::SocketAddr, fail_first: usize) -> DirectDialRefuser {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind the relay middlebox");
    let addr = listener.local_addr().expect("read the middlebox address");
    let hits = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&hits);
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut client, _)) = listener.accept().await else {
                break;
            };
            let count = seen.fetch_add(1, Ordering::SeqCst) + 1;
            if count <= fail_first {
                drop(client);
                continue;
            }
            let Ok(mut upstream) = tokio::net::TcpStream::connect(target).await else {
                drop(client);
                continue;
            };
            tokio::spawn(async move {
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            });
        }
    });
    DirectDialRefuser { addr, hits, handle }
}

/// A listener that records the request line of every connection and closes it,
/// so a dial to it can never succeed.
struct Tripwire {
    addr: std::net::SocketAddr,
    requests: Arc<Mutex<Vec<String>>>,
    handle: JoinHandle<()>,
}

async fn start_tripwire() -> Tripwire {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind the tripwire");
    let addr = listener.local_addr().expect("read the tripwire address");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&requests);
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut client, _)) = listener.accept().await else {
                break;
            };
            let seen = Arc::clone(&seen);
            tokio::spawn(async move {
                let mut buffer = [0_u8; 4096];
                if let Ok(read) = client.read(&mut buffer).await {
                    if read > 0 {
                        let text = String::from_utf8_lossy(&buffer[..read]);
                        let line = text.lines().next().unwrap_or_default().to_string();
                        seen.lock().expect("tripwire lock").push(line);
                    }
                }
                drop(client);
            });
        }
    });
    Tripwire {
        addr,
        requests,
        handle,
    }
}

/// A minimal Server that answers `server.auth` and `server.session.attach` with
/// exactly the payloads a Case supplies. Only the credential-negative fixtures
/// need it: the real Server always mints a P2P credential, so the absence this
/// criterion forbids cannot be produced by it.
struct ScriptedServer {
    addr: std::net::SocketAddr,
    handle: JoinHandle<()>,
}

async fn start_scripted_server(
    p2p_payload: serde_json::Value,
    relay_payload: serde_json::Value,
) -> ScriptedServer {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind the scripted server");
    let addr = listener
        .local_addr()
        .expect("read the scripted server address");
    let handle = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let p2p = p2p_payload.clone();
            let relay = relay_payload.clone();
            tokio::spawn(async move {
                let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                let (mut sink, mut stream) = ws.split();
                while let Some(Ok(WsMessage::Text(text))) = stream.next().await {
                    let Ok(request) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    let reply = match request["msg_type"].as_str() {
                        Some("server.auth") => serde_json::json!({
                            "status": "success",
                            "message": "",
                            "client_id": "scripted-client",
                        }),
                        Some("server.session.attach") => {
                            if request["payload"]["preferred_mode"] == "relay" {
                                relay.clone()
                            } else {
                                p2p.clone()
                            }
                        }
                        _ => continue,
                    };
                    let envelope = serde_json::json!({
                        "msg_type": request["msg_type"],
                        "id": request["id"],
                        "timestamp": 0,
                        "payload": reply,
                    });
                    if sink
                        .send(WsMessage::Text(envelope.to_string()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            });
        }
    });
    ScriptedServer { addr, handle }
}

fn agent_address(url: &str, priority: i32) -> AgentAddress {
    AgentAddress {
        url: url.to_string(),
        label: None,
        network_type: NetworkType::Lan,
        priority,
    }
}

#[tokio::test]
async fn sc01_auto_attach_uses_the_second_advertised_p2p_candidate() {
    let Some(_socket) = harness_socket() else {
        eprintln!("skipped: {HARNESS_SOCKET_ENV} not set (test-harness run only)");
        return;
    };
    if !tmux_available() {
        eprintln!("skipped: tmux not on PATH");
        return;
    }

    let agent_id = "sc01-agent";
    let session_name = unique_session_name("sc01");
    let tmux = SessionManager::new();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .expect("create the tmux session");

    let server = TestServer::start().await;
    let agent = TestAgent::start(agent_id).await;
    let dead_url = format!("ws://127.0.0.1:{}/ws", unused_port());
    let live_url = format!("ws://{}/ws", agent.addr);
    let addresses = vec![agent_address(&dead_url, 1), agent_address(&live_url, 2)];
    let handle = register_agent(&server, &agent, agent_id, addresses).await;
    let sync = start_sync(&handle);

    let session_id = format!("{agent_id}:{session_name}");
    let mut client = connect_client(&server).await;
    wait_for_session(&mut client, &session_id).await;

    let route = resolve_attach_route(client, &session_id, AttachPolicy::Auto, 80, 24)
        .await
        .expect("auto attach should reach the live second candidate");
    assert!(
        !route.relay,
        "a P2P candidate was live; the relay was not needed"
    );
    assert_eq!(
        route.route, live_url,
        "the dial must have used the second advertised candidate"
    );

    let mut transport = route.transport;
    let attach = nession_client::attach_frame(&route.session_name, 80, 24);
    {
        use nession_cli::terminal::TerminalTransport;
        transport
            .send_text(serde_json::to_string(&attach).expect("attach frame"))
            .await
            .expect("send agent.attach");
    }
    await_attach_ack(&mut transport, &route.session_name).await;

    sync.heartbeat.shutdown().await.ok();
    sync.watcher.shutdown().await.ok();
    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();
    agent.handle.shutdown().await.ok();
    server.handle.abort();
}

#[tokio::test]
async fn sc02_auto_attach_falls_back_to_relay_when_every_direct_candidate_fails() {
    let Some(_socket) = harness_socket() else {
        eprintln!("skipped: {HARNESS_SOCKET_ENV} not set (test-harness run only)");
        return;
    };
    if !tmux_available() {
        eprintln!("skipped: tmux not on PATH");
        return;
    }

    let agent_id = "sc02-agent";
    let session_name = unique_session_name("sc02");
    let tmux = SessionManager::new();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .expect("create the tmux session");

    let server = TestServer::start().await;
    let agent = TestAgent::start(agent_id).await;
    let proxy = refuse_direct_dials(agent.addr, 2).await;
    let first_url = format!("ws://{}/ws-a", proxy.addr);
    let second_url = format!("ws://{}/ws-b", proxy.addr);
    let addresses = vec![agent_address(&first_url, 1), agent_address(&second_url, 2)];
    let handle = register_agent(&server, &agent, agent_id, addresses).await;
    let sync = start_sync(&handle);

    let session_id = format!("{agent_id}:{session_name}");
    let mut client = connect_client(&server).await;
    wait_for_session(&mut client, &session_id).await;

    let route = resolve_attach_route(client, &session_id, AttachPolicy::Auto, 80, 24)
        .await
        .expect("auto attach should fall back to the relay");
    assert!(
        route.relay,
        "every direct dial failed, so the relay route was required"
    );
    assert_eq!(route.route, "relay");
    assert_eq!(
        proxy.hits.load(Ordering::SeqCst),
        3,
        "two refused direct dials, then the Server's relay dial"
    );

    let marker = format!("NESSON_2811_RELAY_{}", unique_session_name("marker"));
    let mut transport = route.transport;
    run_terminal_command(&mut transport, &route.session_name, &marker).await;

    sync.heartbeat.shutdown().await.ok();
    sync.watcher.shutdown().await.ok();
    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();
    agent.handle.shutdown().await.ok();
    server.handle.abort();
    proxy.handle.abort();
}

#[tokio::test]
async fn sc02_forced_p2p_reports_an_error_without_relay_fallback() {
    let Some(_socket) = harness_socket() else {
        eprintln!("skipped: {HARNESS_SOCKET_ENV} not set (test-harness run only)");
        return;
    };
    if !tmux_available() {
        eprintln!("skipped: tmux not on PATH");
        return;
    }

    let agent_id = "sc02-forced-p2p";
    let session_name = unique_session_name("sc02-p2p");
    let tmux = SessionManager::new();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .expect("create the tmux session");

    let server = TestServer::start().await;
    let agent = TestAgent::start(agent_id).await;
    let proxy = refuse_direct_dials(agent.addr, 2).await;
    let addresses = vec![
        agent_address(&format!("ws://{}/ws-a", proxy.addr), 1),
        agent_address(&format!("ws://{}/ws-b", proxy.addr), 2),
    ];
    let handle = register_agent(&server, &agent, agent_id, addresses).await;
    let sync = start_sync(&handle);

    let session_id = format!("{agent_id}:{session_name}");
    let mut client = connect_client(&server).await;
    wait_for_session(&mut client, &session_id).await;

    let error = resolve_attach_route(client, &session_id, AttachPolicy::P2p, 80, 24)
        .await
        .err()
        .expect("forced P2P must fail rather than switch to the relay");
    let message = format!("{error:#}");
    assert!(
        message.contains("tried 2"),
        "the error must name both attempted candidates: {message}"
    );
    assert!(
        message.contains("relay fallback"),
        "the error must name the available recovery: {message}"
    );
    assert_eq!(
        proxy.hits.load(Ordering::SeqCst),
        2,
        "forced P2P must not request or dial the relay"
    );

    sync.heartbeat.shutdown().await.ok();
    sync.watcher.shutdown().await.ok();
    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();
    agent.handle.shutdown().await.ok();
    server.handle.abort();
    proxy.handle.abort();
}

#[tokio::test]
async fn sc02_forced_relay_does_not_attempt_p2p() {
    let Some(_socket) = harness_socket() else {
        eprintln!("skipped: {HARNESS_SOCKET_ENV} not set (test-harness run only)");
        return;
    };
    if !tmux_available() {
        eprintln!("skipped: tmux not on PATH");
        return;
    }

    let agent_id = "sc02-forced-relay";
    let session_name = unique_session_name("sc02-relay");
    let tmux = SessionManager::new();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .expect("create the tmux session");

    let server = TestServer::start().await;
    let agent = TestAgent::start(agent_id).await;
    // Nothing is refused: any direct CLI dial would be visible as a count above
    // the Server's single relay dial.
    let proxy = refuse_direct_dials(agent.addr, 0).await;
    let addresses = vec![
        agent_address(&format!("ws://{}/ws-a", proxy.addr), 1),
        agent_address(&format!("ws://{}/ws-b", proxy.addr), 2),
    ];
    let handle = register_agent(&server, &agent, agent_id, addresses).await;
    let sync = start_sync(&handle);

    let session_id = format!("{agent_id}:{session_name}");
    let mut client = connect_client(&server).await;
    wait_for_session(&mut client, &session_id).await;

    let route = resolve_attach_route(client, &session_id, AttachPolicy::Relay, 80, 24)
        .await
        .expect("forced relay should establish through the Server");
    assert!(route.relay);
    assert_eq!(
        proxy.hits.load(Ordering::SeqCst),
        1,
        "forced relay must open exactly one Server relay dial and no direct P2P dial"
    );

    let marker = format!("NESSON_2811_FORCED_RELAY_{}", unique_session_name("marker"));
    let mut transport = route.transport;
    run_terminal_command(&mut transport, &route.session_name, &marker).await;

    sync.heartbeat.shutdown().await.ok();
    sync.watcher.shutdown().await.ok();
    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();
    agent.handle.shutdown().await.ok();
    server.handle.abort();
    proxy.handle.abort();
}

#[tokio::test]
async fn sc03_forced_p2p_without_a_credential_never_dials_the_agent() {
    let tripwire = start_tripwire().await;
    let tripwire_url = format!("ws://{}/ws", tripwire.addr);
    let p2p_payload = serde_json::json!({
        "status": "success",
        "mode": "p2p",
        "session_id": "fake-agent:dev",
        "session_name": "dev",
        "agent_address": tripwire_url,
        "addresses": [{
            "url": tripwire_url,
            "network_type": "lan",
            "priority": 1,
            "status": "unknown",
        }],
        // No `connection_token`: the negative fixture the real Server cannot
        // produce, because it always mints one before answering.
    });
    let relay_payload = serde_json::json!({
        "status": "error",
        "message": "relay unavailable in this fixture",
    });
    let server = start_scripted_server(p2p_payload, relay_payload).await;

    let client = ClientConnection::connect(ClientConfig::new(
        format!("ws://{}", server.addr),
        "scripted-token",
    ))
    .await
    .expect("authenticate with the scripted server");

    let error = resolve_attach_route(client, "fake-agent:dev", AttachPolicy::P2p, 80, 24)
        .await
        .err()
        .expect("a P2P plan without a Server-issued credential must not attach");
    let message = format!("{error:#}");
    assert!(
        message.contains("no connection credential"),
        "the error must name the missing credential: {message}"
    );
    assert!(
        message.contains("no Agent was dialled"),
        "the error must state that no uncredentialed dial happened: {message}"
    );

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        tripwire.requests.lock().expect("tripwire lock").is_empty(),
        "no Agent socket may be opened without the Server-issued credential"
    );

    // Auto records the failed direct route and still refuses to fabricate
    // success when the relay is unavailable too.
    let client = ClientConnection::connect(ClientConfig::new(
        format!("ws://{}", server.addr),
        "scripted-token",
    ))
    .await
    .expect("authenticate with the scripted server");
    let error = resolve_attach_route(client, "fake-agent:dev", AttachPolicy::Auto, 80, 24)
        .await
        .err()
        .expect("no usable route exists, so auto must fail rather than claim success");
    let message = format!("{error:#}");
    assert!(
        message.contains("no connection credential"),
        "the auto error must preserve the direct-route reason: {message}"
    );
    assert!(
        message.contains("relay unavailable in this fixture"),
        "the auto error must carry the Server's relay sentence: {message}"
    );

    server.handle.abort();
    tripwire.handle.abort();
}

#[tokio::test]
async fn sc03_auto_attach_reports_a_bounded_error_when_candidates_and_relay_fail() {
    let tripwire = start_tripwire().await;
    let tripwire_url = format!("ws://{}/ws", tripwire.addr);
    let malformed_url = "ws://[::not-a-host".to_string();
    let credential = "server-issued-credential-2811";
    let p2p_payload = serde_json::json!({
        "status": "success",
        "mode": "p2p",
        "session_id": "fake-agent:dev",
        "session_name": "dev",
        "agent_address": tripwire_url,
        "addresses": [
            {
                "url": tripwire_url,
                "network_type": "lan",
                "priority": 1,
                "status": "unknown",
            },
            {
                "url": malformed_url,
                "network_type": "lan",
                "priority": 2,
                "status": "unknown",
            }
        ],
        "connection_token": credential,
    });
    let relay_payload = serde_json::json!({
        "status": "error",
        "message": "relay unavailable in this fixture",
    });
    let server = start_scripted_server(p2p_payload, relay_payload).await;

    let client = ClientConnection::connect(ClientConfig::new(
        format!("ws://{}", server.addr),
        "scripted-token",
    ))
    .await
    .expect("authenticate with the scripted server");

    let started = Instant::now();
    let error = resolve_attach_route(client, "fake-agent:dev", AttachPolicy::Auto, 80, 24)
        .await
        .err()
        .expect("every route is unusable, so auto must fail");
    let elapsed = started.elapsed();
    let message = format!("{error:#}");

    assert!(
        message.contains("tried 2"),
        "the bounded error must name both exhausted candidates: {message}"
    );
    assert!(
        message.contains("relay unavailable in this fixture"),
        "the bounded error must carry the Server's relay sentence: {message}"
    );
    assert!(
        elapsed < Duration::from_secs(15),
        "candidate exhaustion must be bounded, took {elapsed:?}"
    );

    let requests = tripwire.requests.lock().expect("tripwire lock").clone();
    assert_eq!(
        requests.len(),
        1,
        "the one reachable candidate must have been dialled once: {requests:?}"
    );
    assert!(
        requests[0].contains(&format!("token={credential}")),
        "the dial must present the Server-issued credential: {:?}",
        requests[0]
    );

    server.handle.abort();
    tripwire.handle.abort();
}
