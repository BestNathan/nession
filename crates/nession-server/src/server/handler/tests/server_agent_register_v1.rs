//! Tests localized to the server_agent_register_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn agent_register_no_auth_mode() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "anything",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "accepted");
    assert_eq!(h.registered_agent_id(), Some(&"a1".to_string()));
}

#[tokio::test]
async fn agent_register_valid_token() {
    let mut h = test_handler("secret").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "secret",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "accepted");
}

#[tokio::test]
async fn agent_register_without_a_manifest_is_rejected() {
    // `#678` is a breaking upgrade: an agent this server cannot route for
    // does not connect. Refusing here rather than at the first relay is the
    // difference between an agent that never comes up and one that
    // connects, looks healthy, and silently drops every request aimed at
    // it.
    //
    // A valid auth token, so the rejection can only be the missing
    // manifest — otherwise this test would pass for the wrong reason.
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "old-agent",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "rejected");
    assert!(
        reply["payload"]["message"]
            .as_str()
            .unwrap()
            .contains("no protocol manifest"),
        "the rejection must name the missing manifest: {reply}"
    );
    // And nothing was registered, so no later call can reach it.
    assert!(
        h.agent_registry.get("old-agent").await.is_none(),
        "a rejected agent must not be in the registry"
    );
}

#[tokio::test]
async fn agent_register_invalid_token_rejected() {
    let mut h = test_handler("secret").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "wrong",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "rejected");
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("Invalid auth token"));
}

#[tokio::test]
async fn agent_register_with_addresses() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [
                    { "url": "ws://1.2.3.4:19091/ws", "network_type": "lan", "label": "" }
                ],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "accepted");
    // Verify heartbeat_interval_secs is present
    assert_eq!(reply["payload"]["heartbeat_interval_secs"], 30);
}

// ---- registration is one generation-ordered transition (#960) ----

/// Send `agent_id`'s registration frame with an advertised identity the test
/// can tell apart from another connection's.
///
/// The identity is the value the test reads back: "whose write landed" is a
/// question about *values*, not about which connection believes it registered.
async fn register_advertising(
    h: &mut ConnectionHandler,
    agent_id: &str,
    ip_address: &str,
    port: u16,
    nession_version: &str,
) -> serde_json::Value {
    parse_reply(
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": agent_id,
                "hostname": "host",
                "ip_address": ip_address,
                "port": port,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": nession_version },
            }),
        ))
        .await
        .unwrap(),
    )
}

/// `server.agent.register` publishes an Agent's current generation: it writes
/// the registry (through to SQLite) and clears the previous instance's
/// sessions. It must therefore be ordered against every other registration of
/// the same agent, not merely checked against the generation before it starts
/// writing.
///
/// The schedule is the one the accept loop makes possible: an older socket is
/// accepted but its first frame is slow, so a newer socket registers and
/// claims first. The one-shot per-connection check does not see the old frame
/// as a rebind — that connection has not registered yet — so without
/// generation authority it overwrites the live Agent's endpoint in memory and
/// SQLite and deletes the session the new instance reported, even though the
/// broker refuses its claim immediately afterwards.
#[tokio::test]
async fn a_delayed_older_registration_cannot_overwrite_the_current_generation() {
    use crate::server::outbound::WsMessageSender;

    let deps = TestDeps::new().await;
    let mut older = deps.handler("");
    let mut current = deps.handler("");

    // The newer connection registers, claims, and reports a live session.
    // This is the state the late frame must not move.
    let reply = register_advertising(&mut current, "a1", "10.0.0.2", 19092, "9.9.9").await;
    assert_eq!(reply["payload"]["status"], "accepted");
    let (_current_sender, mut current_rx) = claim_control_channel(&current).await;
    report(
        &mut current,
        proto_msg(
            "server.agent.session-update",
            json!({ "agent_id": "a1", "session_name": "dev", "status": "active", "window_count": 1 }),
        ),
    )
    .await;
    assert!(has_session(&current, "a1:dev").await);

    // The older connection's registration finally arrives.
    let reply = register_advertising(&mut older, "a1", "10.0.0.1", 19001, "0.0.1").await;
    assert_eq!(
        reply["payload"]["status"], "rejected",
        "a registration older than the agent's current generation must be refused: {reply}"
    );
    assert!(
        reply["payload"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("superseded"),
        "the refusal must say the connection was superseded: {reply}"
    );

    // Nothing of the refused registration landed: no binding, no registry or
    // SQLite write, no session removal.
    assert_eq!(
        older.registered_agent_id(),
        None,
        "a refused registration must not bind the connection"
    );
    let a1 = deps
        .agent_registry
        .get("a1")
        .await
        .expect("a1 is registered");
    assert_eq!(a1.ip_address, "10.0.0.2");
    assert_eq!(a1.port, 19092);
    assert_eq!(a1.metadata.nession_version, "9.9.9");
    let persisted = deps.db.list_agents().await.unwrap();
    let row = persisted
        .iter()
        .find(|row| row.agent_id == "a1")
        .expect("a1 is persisted");
    assert_eq!(
        row.ip_address, "10.0.0.2",
        "the stale registration must not reach SQLite either"
    );
    assert_eq!(row.port, 19092);
    assert!(
        has_session(&older, "a1:dev").await,
        "the current generation's session must survive the stale registration"
    );
    let persisted_sessions = deps.db.list_all_sessions().await.unwrap();
    assert!(
        persisted_sessions
            .iter()
            .any(|row| row.session_id == "a1:dev"),
        "the stale registration must not delete the current generation's session rows"
    );

    // Broker ownership is still the current generation's, and a stale claim
    // cannot take it back.
    assert!(
        deps.command_broker
            .is_current_generation("a1", current.connection_generation())
            .await
    );
    assert!(
        !deps
            .command_broker
            .is_current_generation("a1", older.connection_generation())
            .await
    );
    let (stale_sender, mut stale_rx) = WsMessageSender::new();
    deps.command_broker
        .claim_agent("a1", older.connection_generation(), stale_sender)
        .await;
    let _waiter = deps
        .command_broker
        .send_command("a1", "server.session.create", "req-1", json!({}))
        .await;
    assert!(
        current_rx.try_recv().is_ok(),
        "a command must still reach the current generation"
    );
    assert!(
        stale_rx.try_recv().is_err(),
        "a stale claim must not receive the agent's commands"
    );

    // Its later state reports are refused too.
    report(
        &mut older,
        proto_msg(
            "control.heartbeat",
            json!({ "agent_id": "a1", "session_count": 9, "active_sessions": 9 }),
        ),
    )
    .await;
    assert_eq!(
        deps.agent_registry
            .get("a1")
            .await
            .expect("a1 is registered")
            .session_count,
        0,
        "a superseded connection's heartbeat must not be believed"
    );
    report(
        &mut older,
        proto_msg(
            "server.agent.session-update",
            json!({ "agent_id": "a1", "session_name": "dev", "status": "active", "window_count": 7 }),
        ),
    )
    .await;
    let dev = deps
        .session_registry
        .get("a1:dev")
        .await
        .expect("the current generation's session stays");
    assert_eq!(
        dev.window_count, 1,
        "a superseded connection's session update must not overwrite the current state"
    );
}

/// A liveness verdict keeps the generation high-water mark, and the mark is
/// what the registration gate reads — so the eviction of an agent that went
/// quiet is not a gap a stale registration can come back through.
#[tokio::test]
async fn a_stale_registration_cannot_reclaim_after_a_liveness_eviction() {
    let deps = TestDeps::new().await;
    let mut older = deps.handler("");
    let mut current = deps.handler("");

    let reply = register_advertising(&mut current, "a1", "10.0.0.2", 19092, "9.9.9").await;
    assert_eq!(reply["payload"]["status"], "accepted");
    let (_sender, _rx) = claim_control_channel(&current).await;

    deps.command_broker.evict_agent("a1").await;

    let reply = register_advertising(&mut older, "a1", "10.0.0.1", 19001, "0.0.1").await;
    assert_eq!(
        reply["payload"]["status"], "rejected",
        "eviction is a verdict about liveness, not about generations: {reply}"
    );
    assert_eq!(older.registered_agent_id(), None);
    let a1 = deps
        .agent_registry
        .get("a1")
        .await
        .expect("a1 is registered");
    assert_eq!(
        a1.ip_address, "10.0.0.2",
        "the evicted generation's registration is still the agent's current state"
    );
}

/// Two registrations that overlap must end with the newer generation's state,
/// whichever order the per-agent gate serializes them in.
///
/// The gate makes both outcomes correct: older-first means it writes and the
/// newer one overwrites it; newer-first means the older one is refused at the
/// gate and writes nothing. What must never happen is the older write landing
/// after the newer one.
#[tokio::test]
async fn concurrent_registrations_end_with_the_newest_generation() {
    let deps = TestDeps::new().await;
    let mut older = deps.handler("");
    let mut newer = deps.handler("");

    let (older_reply, newer_reply) = tokio::join!(
        register_advertising(&mut older, "a1", "10.0.0.1", 19001, "0.0.1"),
        register_advertising(&mut newer, "a1", "10.0.0.2", 19092, "9.9.9"),
    );

    assert_eq!(newer_reply["payload"]["status"], "accepted");
    assert_eq!(
        older_reply["payload"]["status"] == "accepted",
        older.registered_agent_id().is_some(),
        "an accepted registration binds the connection and a refused one does not"
    );

    let a1 = deps
        .agent_registry
        .get("a1")
        .await
        .expect("a1 is registered");
    assert_eq!(
        a1.ip_address, "10.0.0.2",
        "the newer generation's registration must be the one that remains"
    );
    assert_eq!(a1.port, 19092);
    assert_eq!(a1.metadata.nession_version, "9.9.9");
    assert!(
        deps.command_broker
            .is_current_generation("a1", newer.connection_generation())
            .await
    );
    assert!(
        !deps
            .command_broker
            .is_current_generation("a1", older.connection_generation())
            .await
    );
}
