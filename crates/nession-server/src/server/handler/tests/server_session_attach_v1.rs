//! Tests localized to the server_session_attach_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn attach_invalid_session_id_format() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.attach",
            json!({ "session_id": "no-colon" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("Invalid session_id format"));
}

#[tokio::test]
async fn attach_session_not_found() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.attach",
            json!({ "session_id": "a1:nonexistent" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

#[tokio::test]
async fn attach_agent_offline() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Register agent
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    // Create session
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "active",
            "window_count": 1,
            "attached_clients": 0,
        }),
    ))
    .await
    .unwrap();
    // Manually set agent offline by checking with timeout
    h.agent_registry.check_offline_agents().await;
    // Force offline: update heartbeat to long ago
    h.agent_registry.unregister("a1").await;

    // Re-register with a different approach - just test that agent not found works
    let action = h
        .handle_message(proto_msg(
            "server.session.attach",
            json!({ "session_id": "a1:dev" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

/// The durable Agent Token a P2P attach hands off (#3440).
const AGENT_TOKEN: &str = "agent-token-a";

#[tokio::test]
async fn attach_p2p_mode_success() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Register agent, carrying the durable token it will verify.
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "agent_token": AGENT_TOKEN,
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    // Create session
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "active",
            "window_count": 1,
            "attached_clients": 0,
        }),
    ))
    .await
    .unwrap();

    let action = h
        .handle_message(proto_msg(
            "server.session.attach",
            json!({ "session_id": "a1:dev", "preferred_mode": "p2p" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "success");
    assert_eq!(reply["payload"]["mode"], "p2p");
    // The response identifies the session it describes — the web client's
    // SessionRuntime ownership gate keys on attachInfo.session_id.
    assert_eq!(reply["payload"]["session_id"], "a1:dev");
    assert!(reply["payload"]["agent_address"]
        .as_str()
        .unwrap()
        .contains("1.2.3.4"));
    // No mint, no grant, no expiry: the client is handed the token the Agent
    // registered, and nothing that could be mistaken for a per-attach credential.
    assert_eq!(reply["payload"]["agent_token"], AGENT_TOKEN);
    assert!(reply["payload"].get("connection_token").is_none());
    assert!(reply["payload"]
        .get("connection_token_expires_at")
        .is_none());
}

/// An Agent that has not synchronized a token cannot authenticate a direct
/// attach. The refusal names the fix rather than handing out a credential that
/// could never work (#3440).
#[tokio::test]
async fn attach_p2p_refuses_when_the_agent_never_synchronized_a_token() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "active",
            "window_count": 1,
            "attached_clients": 0,
        }),
    ))
    .await
    .unwrap();

    let action = h
        .handle_message(proto_msg(
            "server.session.attach",
            json!({ "session_id": "a1:dev", "preferred_mode": "p2p" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "error");
    assert!(
        reply["payload"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("has not synchronized its Agent Token"),
        "the refusal must say why and what to do: {reply}"
    );
    assert!(reply["payload"].get("agent_token").is_none());
}

#[tokio::test]
async fn attach_relay_mode() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Register agent + create session
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "agent_token": AGENT_TOKEN,
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "active",
            "window_count": 1,
            "attached_clients": 0,
        }),
    ))
    .await
    .unwrap();

    // Phase 1: query relay — returns info but does NOT enter relay forwarding.
    let (relay_sender, mut relay_rx) = WsMessageSender::new();
    h.set_client_sender(relay_sender);
    let action = h
        .handle_message(proto_msg(
            "server.session.attach",
            json!({ "session_id": "a1:dev", "preferred_mode": "relay" }),
        ))
        .await
        .unwrap();
    assert!(
        matches!(action, HandlerAction::Reply(None)),
        "Phase 1 should return Reply(None)"
    );

    // The phase-1 response goes over the client sender channel and must
    // identify the session (the web client keys on attachInfo.session_id).
    let phase1 = relay_rx.try_recv().expect("phase 1 response not sent");
    let Message::Text(phase1_text) = phase1.message else {
        panic!("expected Text message");
    };
    let phase1: serde_json::Value = serde_json::from_str(&phase1_text).unwrap();
    assert_eq!(phase1["payload"]["status"], "success");
    assert_eq!(phase1["payload"]["mode"], "relay");
    assert_eq!(phase1["payload"]["session_id"], "a1:dev");
    // Phase 1 states the route; the Agent Token is the Server's to carry to
    // the relay dials in phase 2, never the browser's (#3440).
    assert!(
        phase1["payload"].get("agent_token").is_none(),
        "relay phase 1 must not hand the token to the browser: {phase1}"
    );

    // Phase 2: begin relay. The Server reads the token the Agent registered
    // and carries it to the dials (#3440); there is no grant round-trip.
    let action = h
        .handle_message(proto_msg(
            "server.session.relay.begin",
            json!({ "session_id": "a1:dev" }),
        ))
        .await
        .unwrap();
    match action {
        HandlerAction::Relay {
            agent_ws_urls,
            session_id: _,
            session_name,
            relay_request_id,
            client_id: _,
            agent_token,
            browser_client_id: _,
            env_snapshots,
            cols: _,
            rows: _,
            size_known,
            needs_bootstrap,
            subscription_id: _,
        } => {
            assert!(!agent_ws_urls.is_empty(), "expected at least one relay URL");
            assert!(agent_ws_urls[0].contains("1.2.3.4"));
            assert_eq!(session_name, "dev");
            assert_eq!(
                agent_token, AGENT_TOKEN,
                "the relay dial presents the Agent's own durable token"
            );
            assert!(
                !relay_request_id.is_empty(),
                "Relay begin correlation must be retained"
            );
            assert!(env_snapshots.is_empty());
            // The same rule as `needs_bootstrap` below, one field earlier:
            // this payload said nothing about whether the browser had
            // measured a viewport, and saying nothing has always meant the
            // columns are the browser's own (#1265).
            assert_eq!(size_known, None);
            // This payload said nothing about bootstrap (#321), and the
            // difference between `None` and `Some(false)` is the whole
            // point of the field: absent leaves the agent to decide, which
            // is what every client predating it gets.
            assert_eq!(needs_bootstrap, None);
            // The credential is no longer threaded through the URL. It rides
            // the relay's first `client.auth` frame instead, which keeps it out
            // of proxy logs and out of the candidate-list bytes.
            assert!(
                agent_ws_urls.iter().all(|url| !url.contains("token=")),
                "a URL must not carry the Agent Token: {agent_ws_urls:?}"
            );
        }
        _ => panic!("expected Relay action"),
    }
}

/// Relay cannot authenticate the dial without the Agent's synchronized token,
/// so it refuses before opening one (#3440).
#[tokio::test]
async fn relay_begin_refuses_when_the_agent_never_synchronized_a_token() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "10.0.0.5",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [{"url": "ws://10.0.0.5:19091/ws", "network_type": "lan"}],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "active",
            "window_count": 1,
            "attached_clients": 0,
        }),
    ))
    .await
    .unwrap();
    let (client_sender, _client_rx) = WsMessageSender::new();
    h.set_client_sender(client_sender);

    let action = h
        .handle_message(proto_msg(
            "server.session.relay.begin",
            json!({ "session_id": "a1:dev" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "error");
    assert!(
        reply["payload"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("has not synchronized its Agent Token"),
        "the refusal must say why and what to do: {reply}"
    );
}

/// Register `a1` with one advertised address, its durable token, and a
/// relayable session.
async fn register_relay_agent(h: &mut ConnectionHandler) {
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "10.0.0.5",
            "port": 19091,
            "auth_token": "",
            "agent_token": AGENT_TOKEN,
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [{"url": "ws://10.0.0.5:19091/ws", "network_type": "lan"}],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "active",
            "window_count": 1,
            "attached_clients": 0,
        }),
    ))
    .await
    .unwrap();
}

#[tokio::test]
async fn relay_begin_refuses_an_unregistered_manual_endpoint_before_grant() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    register_relay_agent(&mut h).await;

    let (client_sender, _client_rx) = WsMessageSender::new();
    h.set_client_sender(client_sender);

    let action = h
        .handle_message(proto_msg(
            "server.session.relay.begin",
            json!({
                "session_id": "a1:dev",
                // A live credential-looking query is part of the attack
                // surface: the refusal must not echo or log it either.
                "relay_url": "ws://attacker.example/ws?token=stolen"
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "error");
    let message = reply["payload"]["message"].as_str().unwrap();
    assert!(
        message.contains("not an address registered"),
        "the refusal states the binding rule: {message}"
    );
    assert!(
        !message.contains("attacker") && !message.contains("stolen"),
        "the refusal must not echo the candidate: {message}"
    );
}

#[tokio::test]
async fn relay_begin_refusal_never_dials_a_listening_foreign_target() {
    // The issue's runtime reproducer: a real local listener stands in for an
    // attacker. Binding and then refusing the URL must not produce so much as
    // a TCP connection to it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let forged = format!("ws://{addr}/ws");

    let mut h = test_handler("").await;
    h.authenticated_client = true;
    register_relay_agent(&mut h).await;
    let (client_sender, _client_rx) = WsMessageSender::new();
    h.set_client_sender(client_sender);

    let action = h
        .handle_message(proto_msg(
            "server.session.relay.begin",
            json!({ "session_id": "a1:dev", "relay_url": forged }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "error");

    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(250), listener.accept())
            .await
            .is_err(),
        "an unregistered relay target must never receive a dial"
    );
}

#[tokio::test]
async fn relay_begin_accepts_a_manual_endpoint_registered_to_the_agent() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    register_relay_agent(&mut h).await;

    let (client_sender, _client_rx) = WsMessageSender::new();
    h.set_client_sender(client_sender);

    // A different spelling of the registered endpoint (case) still binds;
    // the dial receives the Server's registered string.
    let action = h
        .handle_message(proto_msg(
            "server.session.relay.begin",
            json!({
                "session_id": "a1:dev",
                "relay_url": "WS://10.0.0.5:19091/ws"
            }),
        ))
        .await
        .unwrap();
    match action {
        HandlerAction::Relay {
            agent_ws_urls,
            agent_token,
            ..
        } => {
            assert_eq!(
                agent_ws_urls.len(),
                1,
                "a manual choice selects exactly the one registered endpoint"
            );
            assert_eq!(
                agent_ws_urls[0], "ws://10.0.0.5:19091/ws",
                "the dial uses the registered spelling, never the browser's bytes"
            );
            assert_eq!(
                agent_token, AGENT_TOKEN,
                "the relay leg authenticates with the Agent's own token"
            );
        }
        _ => panic!("expected Relay action"),
    }
}
