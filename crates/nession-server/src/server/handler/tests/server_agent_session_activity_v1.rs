//! Tests localized to the server_agent_session_activity_v1 handler (#3804).
use super::*;

fn register(agent_id: &str) -> serde_json::Value {
    json!({
        "agent_id": agent_id,
        "hostname": "host",
        "ip_address": "1.2.3.4",
        "port": 19091,
        "auth_token": "",
        "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
        "addresses": [],
        "connect_url": null,
        "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
    })
}

fn activity(state: &str, generation: u64) -> serde_json::Value {
    json!({
        "agent_id": "a1",
        "session_name": "dev",
        "instance_id": "inc-1",
        "epoch": "epoch-1",
        "generation": generation,
        "state": state,
        "attention": "input_required",
        "capability_id": "claude-code",
        "observed_at_ms": 1_700_000_000_000_i64,
    })
}

async fn handler_with_session() -> ConnectionHandler {
    let mut h = test_handler("").await;
    h.handle_message(proto_msg("server.agent.register", register("a1")))
        .await
        .unwrap();
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "detached",
            "window_count": 1,
            "attached_clients": 0,
            "instance_id": "inc-1",
        }),
    ))
    .await
    .unwrap();
    h
}

#[tokio::test]
async fn an_activity_level_reaches_the_shared_session_projection() {
    let mut h = handler_with_session().await;
    let before = h
        .session_registry
        .get("a1:dev")
        .await
        .expect("the Session exists")
        .last_activity;

    let action = h
        .handle_message(proto_msg(
            "server.agent.session-activity",
            activity("working", 1),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));

    let stored = h
        .session_registry
        .get("a1:dev")
        .await
        .expect("the Session exists");
    let projected = session_to_info(&stored, None);
    let level = projected.activity.expect("the list carries the activity");
    assert_eq!(level.state, "working");
    assert_eq!(level.attention.as_deref(), Some("input_required"));
    assert_eq!(level.capability_id.as_deref(), Some("claude-code"));
    assert_eq!(projected.status, "detached", "lifecycle is untouched");
    assert_eq!(
        stored.last_activity, before,
        "an activity level is not interaction recency"
    );

    // The same shared serializer backs the push, so the pushed and listed rows
    // agree by construction.
    let pushed = session_to_json(&stored, None);
    assert_eq!(pushed["activity"]["state"], "working");

    // A later level replaces it; the reverse order is refused.
    h.handle_message(proto_msg(
        "server.agent.session-activity",
        activity("idle", 2),
    ))
    .await
    .unwrap();
    h.handle_message(proto_msg(
        "server.agent.session-activity",
        activity("working", 1),
    ))
    .await
    .unwrap();
    assert_eq!(
        h.session_registry
            .get("a1:dev")
            .await
            .unwrap()
            .activity
            .unwrap()
            .state,
        "idle"
    );
}

#[tokio::test]
async fn a_legacy_agent_session_lists_activity_as_absent() {
    let h = handler_with_session().await;
    let stored = h.session_registry.get("a1:dev").await.unwrap();
    let projected = session_to_info(&stored, None);
    assert!(
        projected.activity.is_none(),
        "missing activity is unknown, not idle"
    );
}

#[tokio::test]
async fn malformed_or_stale_activity_is_refused_without_writing() {
    let mut h = handler_with_session().await;

    for payload in [
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "instance_id": "inc-2",
            "epoch": "epoch-1",
            "generation": 1,
            "state": "working",
            "observed_at_ms": 1,
        }),
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "instance_id": "inc-1",
            "epoch": "epoch-1",
            "generation": 1,
            "state": "sleeping",
            "observed_at_ms": 1,
        }),
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "instance_id": "inc-1",
            "epoch": "epoch-1",
            "generation": 0,
            "state": "working",
            "observed_at_ms": 1,
        }),
        json!({
            "agent_id": "other",
            "session_name": "dev",
            "instance_id": "inc-1",
            "epoch": "epoch-1",
            "generation": 1,
            "state": "working",
            "observed_at_ms": 1,
        }),
    ] {
        h.handle_message(proto_msg("server.agent.session-activity", payload))
            .await
            .unwrap();
    }

    assert!(
        h.session_registry
            .get("a1:dev")
            .await
            .unwrap()
            .activity
            .is_none(),
        "no refused frame may become a Web-visible level"
    );
}
