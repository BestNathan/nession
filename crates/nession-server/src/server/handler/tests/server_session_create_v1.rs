//! Tests localized to the server_session_create_v1 handler (Issue #1258).
use super::*;

/// Regression #743: the agent WebSocket loop claims the agent for its
/// connection on **every** inbound agent message (`server/websocket.rs`),
/// so that can happen while a command is in flight. It is a transport
/// update and must not cancel the command — otherwise the client is told
/// "Agent disconnected" for a session the agent actually created, and the
/// real response is discarded when it arrives.
#[tokio::test]
async fn session_create_survives_an_intervening_agent_message() {
    let mut h = handler_with_online_agent().await;

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let create_fut = h.handle_message(proto_msg(
        "server.session.create",
        json!({ "agent_id": "a1", "name": "regression-743" }),
    ));
    let agent_fut = async move {
        let text = rx
            .recv()
            .await
            .expect("agent should receive session.create")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();

        // An unrelated inbound message from the same agent arrives first;
        // the loop claims the agent for the connection that sent it — a
        // newer one here, standing in for a reconnect.
        let (sender_again, _keepalive) = WsMessageSender::new();
        let generation = broker.new_connection_generation();
        broker.claim_agent("a1", generation, sender_again).await;

        broker
            .resolve_command("a1", &request_id, json!({ "success": true }))
            .await;
    };
    let (action, ()) = tokio::join!(create_fut, agent_fut);
    let reply = parse_reply(action.unwrap());

    assert_eq!(
        reply["payload"]["success"],
        json!(true),
        "an intervening agent message must not turn a completed create into a reported failure"
    );
    assert_eq!(reply["payload"]["session_id"], json!("a1:regression-743"));
}

/// The agent can report its new tmux pane while the create request is still
/// waiting for its command response. The eventual success ACK must not erase
/// the authoritative foreground command and turn the UI back to "unknown".
#[tokio::test]
async fn session_create_success_preserves_agent_report_that_arrived_first() {
    use crate::registry::session::{SessionInfo, SessionStatus};
    let mut h = handler_with_online_agent().await;
    let registry = Arc::clone(&h.session_registry);
    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let create = h.handle_message(proto_msg(
        "server.session.create",
        json!({ "agent_id": "a1", "name": "fast-reported" }),
    ));
    let report_then_ack = async move {
        let wire = rx.recv().await.expect("Agent received create request");
        let request: serde_json::Value =
            serde_json::from_str(wire.message.to_text().unwrap()).unwrap();
        let request_id = request["payload"]["request_id"].as_str().unwrap();

        let now = chrono::Utc::now();
        registry
            .update_session(SessionInfo {
                session_id: "a1:fast-reported".to_string(),
                agent_id: "a1".to_string(),
                session_name: "fast-reported".to_string(),
                status: SessionStatus::Active,
                window_count: 1,
                attached_clients: 0,
                foreground_command: Some("bash".to_string()),
                working_dir: Some("/srv".to_string()),
                created_at: now,
                last_activity: now,
            })
            .await;
        broker
            .resolve_command("a1", request_id, json!({ "success": true }))
            .await;
    };
    let (action, ()) = tokio::join!(create, report_then_ack);
    let response = parse_reply(action.unwrap());
    assert_eq!(response["payload"]["success"], true);
    assert_eq!(response["payload"]["session_id"], "a1:fast-reported");

    let persisted = h.session_registry.get("a1:fast-reported").await.unwrap();
    assert_eq!(persisted.foreground_command.as_deref(), Some("bash"));
    assert_eq!(persisted.working_dir.as_deref(), Some("/srv"));
    assert_eq!(persisted.status, SessionStatus::Active);
}

#[tokio::test]
async fn session_create_missing_fields() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.create",
            json!({ "agent_id": "", "name": "" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("required"));
}

#[tokio::test]
async fn session_create_agent_not_found() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.create",
            json!({ "agent_id": "nonexistent", "name": "dev" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

fn env_file(name: &str) -> EnvFileRef {
    EnvFileRef {
        name: name.to_string(),
        source: EnvSource::Server,
        agent_id: None,
    }
}

/// Run one `server.session.create` and answer it as the Agent would.
async fn answer_create(
    h: &mut ConnectionHandler,
    name: &str,
    env_files: serde_json::Value,
    response: serde_json::Value,
) -> serde_json::Value {
    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    let broker = Arc::clone(&h.command_broker);

    let create = h.handle_message(proto_msg(
        "server.session.create",
        json!({ "agent_id": "a1", "name": name, "env_files": env_files }),
    ));
    let agent = async move {
        let text = rx
            .recv()
            .await
            .expect("Agent receives session.create")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        let request_id = parsed["payload"]["request_id"].as_str().unwrap();
        broker.resolve_command("a1", request_id, response).await;
    };
    let (action, ()) = tokio::join!(create, agent);
    parse_reply(action.unwrap())
}

/// #2999 SC-01: a duplicate-name create that selected a profile is refused and
/// must leave the live Session's desired binding untouched.
#[tokio::test]
async fn duplicate_create_with_profiles_preserves_the_existing_binding() {
    let mut h = handler_with_online_agent().await;
    h.env_service
        .store
        .write("a.env", "A=1", false)
        .await
        .unwrap();
    h.env_service
        .store
        .write("b.env", "B=2", false)
        .await
        .unwrap();
    bind_for_test(&h, "a1:dev", &[env_file("a.env")]).await;

    let reply = answer_create(
        &mut h,
        "dev",
        json!([env_file("b.env")]),
        json!({ "success": false, "error": "session 'dev' already exists" }),
    )
    .await;

    assert_eq!(reply["payload"]["success"], false);
    let stored = h
        .env_service
        .bindings
        .get("a1:dev")
        .await
        .unwrap()
        .expect("the existing Session's desired binding must survive the refusal");
    assert_eq!(stored.desired_revision, 1);
    assert_eq!(stored.profiles.len(), 1);
    assert_eq!(stored.profiles[0].profile.name, "a.env");
}

/// #2999 SC-01: the no-profile duplicate used to clear the live binding before
/// sending; a refusal must not clear it either.
#[tokio::test]
async fn duplicate_create_without_profiles_preserves_the_existing_binding() {
    let mut h = handler_with_online_agent().await;
    h.env_service
        .store
        .write("a.env", "A=1", false)
        .await
        .unwrap();
    bind_for_test(&h, "a1:dev", &[env_file("a.env")]).await;

    let reply = answer_create(
        &mut h,
        "dev",
        json!([]),
        json!({ "success": false, "error": "session 'dev' already exists" }),
    )
    .await;

    assert_eq!(reply["payload"]["success"], false);
    let stored = h
        .env_service
        .bindings
        .get("a1:dev")
        .await
        .unwrap()
        .expect("an empty duplicate create must not clear the live binding");
    assert_eq!(stored.profiles[0].profile.name, "a.env");
}

/// #2999: a successful new Session replaces a stale same-named row with its own
/// requested selection, and the Session is registered.
#[tokio::test]
async fn successful_create_applies_the_staged_binding_after_the_agent_confirms() {
    let mut h = handler_with_online_agent().await;
    h.env_service
        .store
        .write("stale.env", "OLD=1", false)
        .await
        .unwrap();
    h.env_service
        .store
        .write("b.env", "B=2", false)
        .await
        .unwrap();
    let stale_profiles =
        crate::env::binding::materialized_profiles(&[], &[env_file("stale.env")], "create");
    h.env_service
        .bindings
        .put(&crate::env::BindingRecord {
            session_id: "a1:new".to_string(),
            agent_id: "a1".to_string(),
            desired_revision: 1,
            profiles: stale_profiles,
            updated_at: 0,
        })
        .await
        .unwrap();

    let reply = answer_create(
        &mut h,
        "new",
        json!([env_file("b.env")]),
        json!({ "success": true }),
    )
    .await;

    assert_eq!(reply["payload"]["success"], true);
    let stored = h
        .env_service
        .bindings
        .get("a1:new")
        .await
        .unwrap()
        .expect("the new Session's binding is durable");
    assert_eq!(stored.desired_revision, 1);
    assert_eq!(stored.profiles.len(), 1);
    assert_eq!(stored.profiles[0].profile.name, "b.env");
    assert!(h.session_registry.get("a1:new").await.is_some());
}

/// #2999: a new Session that selects no profiles clears a stale same-named row
/// only after the Agent confirms the create.
#[tokio::test]
async fn successful_create_without_profiles_clears_a_stale_row() {
    let mut h = handler_with_online_agent().await;
    h.env_service
        .store
        .write("stale.env", "OLD=1", false)
        .await
        .unwrap();
    let stale_profiles =
        crate::env::binding::materialized_profiles(&[], &[env_file("stale.env")], "create");
    h.env_service
        .bindings
        .put(&crate::env::BindingRecord {
            session_id: "a1:empty".to_string(),
            agent_id: "a1".to_string(),
            desired_revision: 1,
            profiles: stale_profiles,
            updated_at: 0,
        })
        .await
        .unwrap();

    let reply = answer_create(&mut h, "empty", json!([]), json!({ "success": true })).await;

    assert_eq!(reply["payload"]["success"], true);
    assert!(
        h.env_service
            .bindings
            .get("a1:empty")
            .await
            .unwrap()
            .is_none(),
        "a successful empty create starts a new Session without the stale row"
    );
}

/// #2999 SC-02: two coordinated same-name creates share the real handler,
/// broker and durable store. Exactly one is accepted; the rejected attempt's
/// candidate must not erase or replace the accepted binding, regardless of
/// which response settles first.
#[tokio::test]
async fn concurrent_same_name_creates_keep_the_accepted_binding() {
    for refuse_first in [false, true] {
        let deps = TestDeps::new().await;
        let mut h1 = deps.handler("");
        h1.authenticated_client = true;
        register_online_agent(&mut h1).await;
        let mut h2 = deps.handler("");
        h2.authenticated_client = true;

        deps.env_service
            .store
            .write("a.env", "A=1", false)
            .await
            .unwrap();
        deps.env_service
            .store
            .write("b.env", "B=2", false)
            .await
            .unwrap();

        let (sender, mut rx) = WsMessageSender::new();
        let generation = h1.command_broker.new_connection_generation();
        h1.command_broker
            .claim_agent("a1", generation, sender)
            .await;
        let broker = Arc::clone(&h1.command_broker);

        let create_a = h1.handle_message(proto_msg(
            "server.session.create",
            json!({ "agent_id": "a1", "name": "race", "env_files": [env_file("a.env")] }),
        ));
        let create_b = h2.handle_message(proto_msg(
            "server.session.create",
            json!({ "agent_id": "a1", "name": "race", "env_files": [env_file("b.env")] }),
        ));
        let agent = async move {
            let mut accepted = None;
            let mut rejected = None;
            for _ in 0..2 {
                let text = rx
                    .recv()
                    .await
                    .expect("Agent receives both creates")
                    .message
                    .to_text()
                    .unwrap()
                    .to_string();
                let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
                let request_id = parsed["payload"]["request_id"]
                    .as_str()
                    .unwrap()
                    .to_string();
                let profile = parsed["payload"]["binding_profiles"][0]["profile"]["name"]
                    .as_str()
                    .unwrap()
                    .to_string();
                if profile == "a.env" {
                    accepted = Some(request_id);
                } else {
                    rejected = Some(request_id);
                }
            }
            let accepted = accepted.expect("the a.env create reached the Agent");
            let rejected = rejected.expect("the b.env create reached the Agent");
            if refuse_first {
                broker
                    .resolve_command(
                        "a1",
                        &rejected,
                        json!({ "success": false, "error": "duplicate" }),
                    )
                    .await;
                broker
                    .resolve_command("a1", &accepted, json!({ "success": true }))
                    .await;
            } else {
                broker
                    .resolve_command("a1", &accepted, json!({ "success": true }))
                    .await;
                broker
                    .resolve_command(
                        "a1",
                        &rejected,
                        json!({ "success": false, "error": "duplicate" }),
                    )
                    .await;
            }
        };

        let (action_a, action_b, ()) = tokio::join!(create_a, create_b, agent);
        let reply_a = parse_reply(action_a.unwrap());
        let reply_b = parse_reply(action_b.unwrap());
        assert_eq!(reply_a["payload"]["success"], true);
        assert_eq!(reply_b["payload"]["success"], false);

        let stored = deps
            .env_service
            .bindings
            .get("a1:race")
            .await
            .unwrap()
            .expect("the accepted attempt's binding must survive");
        assert_eq!(stored.desired_revision, 1);
        assert_eq!(stored.profiles.len(), 1);
        assert_eq!(stored.profiles[0].profile.name, "a.env");
        assert!(deps.session_registry.get("a1:race").await.is_some());
    }
}

// ── Project-aware create (#3025) ────────────────────────────────────────

use nession_protocol::contracts::project::v1::ProjectLocation;

const PROJECT_ID: &str = "project-123e4567-e89b-42d3-a456-426614174000";

async fn seed_project(h: &ConnectionHandler, project_id: &str, locations: Vec<ProjectLocation>) {
    h.db.insert_project(&crate::db::ProjectRow {
        project_id: project_id.to_string(),
        name: "Fixtures".to_string(),
        description: None,
        source: None,
        locations,
        session_defaults: None,
        image_digest: None,
        created_at: 1,
        updated_at: 1,
    })
    .await
    .unwrap();
}

fn location(agent_id: &str, path: &str) -> ProjectLocation {
    ProjectLocation {
        agent_id: agent_id.to_string(),
        path: path.to_string(),
    }
}

/// A Project-aware create validates the declared Existing Location, then sends
/// that directory as the Agent's initial cwd. The Project itself never reaches
/// the Agent: the Session owns the realized environment.
#[tokio::test]
async fn project_session_create_uses_the_declared_existing_location() {
    let mut h = handler_with_online_agent().await;
    seed_project(&h, PROJECT_ID, vec![location("a1", "/srv/project")]).await;

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    let broker = Arc::clone(&h.command_broker);

    let create = h.handle_message(proto_msg(
        "server.session.create",
        json!({
            "agent_id": "a1",
            "name": "from-project",
            "working_dir": "/srv/project",
            "project_id": PROJECT_ID,
        }),
    ));
    let agent = async move {
        let text = rx
            .recv()
            .await
            .expect("Agent receives session.create")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["payload"]["working_dir"], "/srv/project");
        assert_eq!(parsed["payload"]["name"], "from-project");
        assert!(
            parsed["payload"].get("project_id").is_none(),
            "the Project declaration must not leak into the Agent payload: {parsed}"
        );
        let request_id = parsed["payload"]["request_id"].as_str().unwrap();
        broker
            .resolve_command("a1", request_id, json!({ "success": true }))
            .await;
    };
    let (action, ()) = tokio::join!(create, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(reply["payload"]["session_id"], "a1:from-project");
}

#[tokio::test]
async fn project_session_create_rejects_an_unknown_project() {
    let mut h = handler_with_online_agent().await;
    let reply = create_reply(
        &mut h,
        json!({
            "agent_id": "a1",
            "name": "unknown-project",
            "working_dir": "/srv/project",
            "project_id": PROJECT_ID,
        }),
    )
    .await;

    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not found"));
    assert!(h.session_registry.get("a1:unknown-project").await.is_none());
}

#[tokio::test]
async fn project_session_create_rejects_a_directory_outside_the_project() {
    let mut h = handler_with_online_agent().await;
    seed_project(&h, PROJECT_ID, vec![location("a1", "/srv/project")]).await;

    let reply = create_reply(
        &mut h,
        json!({
            "agent_id": "a1",
            "name": "wrong-directory",
            "working_dir": "/srv/other",
            "project_id": PROJECT_ID,
        }),
    )
    .await;

    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not an Existing Location"));
}

#[tokio::test]
async fn project_session_create_requires_a_directory() {
    let mut h = handler_with_online_agent().await;
    seed_project(&h, PROJECT_ID, vec![location("a1", "/srv/project")]).await;

    let reply = create_reply(
        &mut h,
        json!({
            "agent_id": "a1",
            "name": "missing-directory",
            "project_id": PROJECT_ID,
        }),
    )
    .await;

    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("requires an Existing Location"));
}

/// The pre-Project create path is unchanged even when Projects exist.
#[tokio::test]
async fn legacy_session_create_without_a_project_is_unchanged() {
    let mut h = handler_with_online_agent().await;
    seed_project(&h, PROJECT_ID, vec![location("a1", "/srv/project")]).await;

    let reply = answer_create(
        &mut h,
        "legacy-create",
        json!([]),
        json!({ "success": true }),
    )
    .await;

    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(reply["payload"]["session_id"], "a1:legacy-create");
}

/// A create that is refused before any Agent command is sent.
async fn create_reply(h: &mut ConnectionHandler, payload: serde_json::Value) -> serde_json::Value {
    parse_reply(
        h.handle_message(proto_msg("server.session.create", payload))
            .await
            .unwrap(),
    )
}
