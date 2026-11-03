//! Tests localized to the Session Environment Binding units (#170).
use super::*;
use crate::registry::session::{SessionInfo, SessionStatus};
use crate::server::outbound::WsMessageSender;

async fn register_session(h: &ConnectionHandler, session_id: &str) {
    let (agent_id, session_name) = session_id.split_once(':').expect("agent:name");
    let now = chrono::Utc::now();
    h.session_registry
        .insert_session_if_absent(SessionInfo {
            session_id: session_id.to_string(),
            agent_id: agent_id.to_string(),
            session_name: session_name.to_string(),
            status: SessionStatus::Detached,
            window_count: 1,
            attached_clients: 0,
            foreground_command: None,
            working_dir: None,
            created_at: now,
            last_activity: now,
        })
        .await;
}

fn file(name: &str) -> EnvFileRef {
    EnvFileRef {
        name: name.to_string(),
        source: EnvSource::Server,
        agent_id: None,
    }
}

/// Answer one `agent.session.env.binding.set` and return the payload it saw.
async fn answer_binding_set(
    rx: &mut tokio::sync::mpsc::Receiver<crate::server::outbound::QueuedFrame>,
    broker: &Arc<crate::server::command_broker::CommandBroker>,
    observed: serde_json::Value,
) -> serde_json::Value {
    let text = rx
        .recv()
        .await
        .expect("Agent receives the binding replacement")
        .message
        .to_text()
        .unwrap()
        .to_string();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        parsed["msg_type"], "agent.session.env.binding.set",
        "the binding must travel on its canonical wire"
    );
    let request_id = parsed["payload"]["request_id"].as_str().unwrap();
    broker
        .resolve_command(
            "a1",
            request_id,
            json!({ "success": true, "observed": observed }),
        )
        .await;
    parsed
}

fn observed(revision: u64) -> serde_json::Value {
    json!({
        "applied_revision": revision,
        "status": "in_sync",
        "profiles": [],
        "managed_keys": ["MODE"],
    })
}

#[tokio::test]
async fn binding_set_persists_the_whole_ordered_selection_and_reports_observed() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    h.env_service
        .store
        .write("base.env", "MODE=base", false)
        .await
        .unwrap();
    h.env_service
        .store
        .write("staging.env", "MODE=staging", false)
        .await
        .unwrap();

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    let broker = Arc::clone(&h.command_broker);

    let set = h.handle_message(proto_msg(
        "server.session.env.binding.set",
        json!({
            "session_id": "a1:s1",
            "profiles": [file("base.env"), file("staging.env")],
        }),
    ));
    let agent = async move { answer_binding_set(&mut rx, &broker, observed(1)).await };
    let (action, sent) = tokio::join!(set, agent);
    let reply = parse_reply(action.unwrap());

    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(reply["payload"]["binding"]["desired_revision"], 1);
    assert_eq!(
        reply["payload"]["binding"]["desired_profiles"][0]["profile"]["name"],
        "base.env"
    );
    assert_eq!(
        reply["payload"]["binding"]["desired_profiles"][1]["profile"]["name"],
        "staging.env"
    );
    assert_eq!(
        reply["payload"]["binding"]["observed"]["applied_revision"],
        1
    );
    assert_eq!(sent["payload"]["name"], "s1");
    assert_eq!(sent["payload"]["revision"], 1);
    // Both snapshots are resolved now, in order, with the later profile's
    // value materialized. Nothing is constructed by separate apply calls.
    assert_eq!(
        sent["payload"]["snapshots"][0]["vars"],
        json!([["MODE", "base"]])
    );
    assert_eq!(
        sent["payload"]["snapshots"][1]["vars"],
        json!([["MODE", "staging"]])
    );

    let stored = h
        .env_service
        .bindings
        .get("a1:s1")
        .await
        .unwrap()
        .expect("desired binding is durable");
    assert_eq!(stored.profiles.len(), 2);
    assert_eq!(stored.desired_revision, 1);
}

#[tokio::test]
async fn binding_set_is_a_replacement_and_preserves_create_phase() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    h.env_service
        .store
        .write("base.env", "A=1", false)
        .await
        .unwrap();
    h.env_service
        .store
        .write("extra.env", "B=2", false)
        .await
        .unwrap();
    // The Session was created with `base.env`.
    bind_for_test(&h, "a1:s1", &[file("base.env")]).await;

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    let broker = Arc::clone(&h.command_broker);

    let set = h.handle_message(proto_msg(
        "server.session.env.binding.set",
        json!({
            "session_id": "a1:s1",
            "profiles": [file("base.env"), file("extra.env")],
        }),
    ));
    let agent = async move { answer_binding_set(&mut rx, &broker, observed(2)).await };
    let (action, _) = tokio::join!(set, agent);
    let reply = parse_reply(action.unwrap());

    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(
        reply["payload"]["binding"]["desired_profiles"][0]["phase"], "create",
        "a profile the Session was created with keeps its provenance"
    );
    assert_eq!(
        reply["payload"]["binding"]["desired_profiles"][1]["phase"],
        "attach"
    );
    assert_eq!(reply["payload"]["binding"]["desired_revision"], 2);
}

#[tokio::test]
async fn binding_set_keeps_desired_when_the_agent_fails_to_materialize() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    h.env_service
        .store
        .write("base.env", "A=1", false)
        .await
        .unwrap();

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    let broker = Arc::clone(&h.command_broker);

    let set = h.handle_message(proto_msg(
        "server.session.env.binding.set",
        json!({ "session_id": "a1:s1", "profiles": [file("base.env")] }),
    ));
    let agent = async move {
        let text = rx
            .recv()
            .await
            .unwrap()
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        let request_id = parsed["payload"]["request_id"].as_str().unwrap();
        broker
            .resolve_command(
                "a1",
                request_id,
                json!({ "success": false, "error": "tmux refused", "observed": observed(0) }),
            )
            .await;
    };
    let (action, ()) = tokio::join!(set, agent);
    let reply = parse_reply(action.unwrap());

    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(reply["payload"]["error"], "tmux refused");
    assert_eq!(
        reply["payload"]["binding"]["desired_revision"], 1,
        "the desired intent survives a failed materialization"
    );
    assert!(h.env_service.bindings.get("a1:s1").await.unwrap().is_some());
}

#[tokio::test]
async fn binding_reapply_resolves_current_content_at_a_new_revision() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    h.env_service
        .store
        .write("base.env", "MODE=v1", false)
        .await
        .unwrap();

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    let broker = Arc::clone(&h.command_broker);

    let set = h.handle_message(proto_msg(
        "server.session.env.binding.set",
        json!({ "session_id": "a1:s1", "profiles": [file("base.env")] }),
    ));
    let agent = async { answer_binding_set(&mut rx, &broker, observed(1)).await };
    let (action, _) = tokio::join!(set, agent);
    assert_eq!(parse_reply(action.unwrap())["payload"]["success"], true);

    // The profile is edited. Ordinary save does not touch the Session.
    h.env_service
        .store
        .write("base.env", "MODE=v2", true)
        .await
        .unwrap();
    assert_eq!(
        h.env_service
            .bindings
            .get("a1:s1")
            .await
            .unwrap()
            .unwrap()
            .desired_revision,
        1
    );

    let reapply = h.handle_message(proto_msg(
        "server.session.env.binding.reapply",
        json!({ "session_id": "a1:s1" }),
    ));
    let agent = async { answer_binding_set(&mut rx, &broker, observed(2)).await };
    let (action, sent) = tokio::join!(reapply, agent);
    let reply = parse_reply(action.unwrap());

    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(sent["payload"]["revision"], 2);
    assert_eq!(
        sent["payload"]["snapshots"][0]["vars"],
        json!([["MODE", "v2"]]),
        "reapply reads the profile content at that moment"
    );
}

#[tokio::test]
async fn legacy_unset_does_not_read_the_removed_profile() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    h.env_service
        .store
        .write("keep.env", "K=1", false)
        .await
        .unwrap();
    h.env_service
        .store
        .write("gone.env", "G=1", false)
        .await
        .unwrap();
    bind_for_test(&h, "a1:s1", &[file("keep.env"), file("gone.env")]).await;

    // The removed profile disappears after materialization. Cleanup must be
    // derived from the binding, not from re-reading this file.
    h.env_service.store.delete("gone.env").await.unwrap();

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    let broker = Arc::clone(&h.command_broker);

    let unset = h.handle_message(proto_msg(
        "server.session.env.unset",
        json!({ "session_id": "a1:s1", "env_files": [file("gone.env")] }),
    ));
    let agent = async move { answer_binding_set(&mut rx, &broker, observed(2)).await };
    let (action, sent) = tokio::join!(unset, agent);
    let reply = parse_reply(action.unwrap());

    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(sent["payload"]["profiles"].as_array().unwrap().len(), 1);
    assert_eq!(
        sent["payload"]["profiles"][0]["profile"]["name"],
        "keep.env"
    );
}

#[tokio::test]
async fn session_env_query_asks_the_agent_about_that_session_only() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    let broker = Arc::clone(&h.command_broker);

    let query = h.handle_message(proto_msg(
        "server.session.env.query",
        json!({ "session_id": "a1:s1" }),
    ));
    let agent = async move {
        let text = rx
            .recv()
            .await
            .unwrap()
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["msg_type"], "agent.session.env.binding.get");
        assert_eq!(
            parsed["payload"]["name"], "s1",
            "the Agent must be asked about this Session, not its whole state"
        );
        let request_id = parsed["payload"]["request_id"].as_str().unwrap();
        broker
            .resolve_command(
                "a1",
                request_id,
                json!({
                    "success": true,
                    "observed": {
                        "applied_revision": 3,
                        "status": "in_sync",
                        "profiles": [{ "name": "s1.env", "source": "server" }],
                        "managed_keys": ["X"]
                    }
                }),
            )
            .await;
    };
    let (action, ()) = tokio::join!(query, agent);
    let reply = parse_reply(action.unwrap());

    assert_eq!(reply["payload"]["sourced_files"], json!(["s1.env"]));
    // The answer is cached for the observed half of a later `binding.get`.
    let cached = h
        .env_service
        .observed
        .get("a1:s1")
        .expect("the observed state is cached");
    assert_eq!(cached.applied_revision, 3);
}

#[tokio::test]
async fn an_agent_binding_report_updates_only_known_sessions() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:known").await;

    h.handle_message(proto_msg(
        "server.agent.session-env-binding",
        json!({
            "agent_id": "a1",
            "sessions": [
                { "session_name": "known", "observed": observed(4) },
                { "session_name": "stale", "observed": observed(9) },
            ],
        }),
    ))
    .await
    .unwrap();

    assert!(h.env_service.observed.get("a1:known").is_some());
    assert!(
        h.env_service.observed.get("a1:stale").is_none(),
        "a state file for a Session the registry does not know is not a live claim"
    );
}
