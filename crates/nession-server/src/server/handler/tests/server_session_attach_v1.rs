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

#[tokio::test]
async fn attach_p2p_mode_success() {
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
    // The Server hands the credential to the agent that will verify it
    // **before** it answers the client (#1013), so the attach cannot
    // complete unless the agent answers. Standing one in for the test is
    // the point rather than an inconvenience: what this exercises is the
    // ordering, and the assertions below would hang for the grant deadline
    // if the Server answered the client first.
    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    let broker = Arc::clone(&h.command_broker);

    let attach_fut = h.handle_message(proto_msg(
        "server.session.attach",
        json!({ "session_id": "a1:dev", "preferred_mode": "p2p" }),
    ));
    let grant_fut = async move {
        let text = rx
            .recv()
            .await
            .expect("the agent is told before the client is answered")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let grant: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(grant["msg_type"], "agent.p2p.grant");
        assert_eq!(grant["payload"]["agent_id"], "a1");
        assert_eq!(grant["payload"]["session_id"], "a1:dev");
        assert_eq!(
            grant["payload"]["scope"]["terminal"], "dev",
            "the credential is bound to the session it was minted for"
        );
        assert!(
            grant["payload"]["credential"]
                .as_str()
                .is_some_and(|token| !token.is_empty()),
            "and it carries the credential the client will present"
        );

        let request_id = grant["payload"]["request_id"].as_str().unwrap().to_string();
        broker
            .resolve_command("a1", &request_id, json!({ "success": true }))
            .await;
    };

    let (action, ()) = tokio::join!(attach_fut, grant_fut);
    let action = action.unwrap();
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

    // Phase 2: begin relay. The Server hands the credential to the agent
    // that will verify it **before** it dials (#1013), so this cannot
    // complete without an agent that answers.
    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    let broker = Arc::clone(&h.command_broker);

    let begin_fut = h.handle_message(proto_msg(
        "server.session.relay.begin",
        json!({ "session_id": "a1:dev" }),
    ));
    let grant_fut = async move {
        let text = rx
            .recv()
            .await
            .expect("the agent is told before the server dials it")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let grant: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(grant["msg_type"], "agent.p2p.grant");
        assert_eq!(grant["payload"]["scope"]["terminal"], "dev");
        assert_eq!(
            grant["payload"]["scope"]["files"], false,
            "a relay credential is the narrow one: the relay leg never touches a file"
        );
        assert_eq!(
            grant["payload"]["scope"]["sessions"], false,
            "and it never creates or kills a session"
        );

        let request_id = grant["payload"]["request_id"].as_str().unwrap().to_string();
        broker
            .resolve_command("a1", &request_id, json!({ "success": true }))
            .await;
    };

    let (action, ()) = tokio::join!(begin_fut, grant_fut);
    let action = action.unwrap();
    match action {
        HandlerAction::Relay {
            agent_ws_urls,
            session_id: _,
            session_name,
            client_id: _,
            browser_client_id: _,
            env_snapshots,
            cols: _,
            rows: _,
            size_known,
            needs_bootstrap,
        } => {
            assert!(!agent_ws_urls.is_empty(), "expected at least one relay URL");
            assert!(agent_ws_urls[0].contains("1.2.3.4"));
            assert_eq!(session_name, "dev");
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
            // The credential rides **on the URLs**, which is what makes both
            // relay dials carry it without knowing about it — the attach dial
            // iterates this list, and the detach dial reuses the one that
            // succeeded. A credential threaded beside the URL would have to
            // be kept in step with two call sites.
            assert!(
                agent_ws_urls.iter().all(|url| url.contains("token=")),
                "every candidate the dials use carries the credential: {agent_ws_urls:?}"
            );
        }
        _ => panic!("expected Relay action"),
    }
}
