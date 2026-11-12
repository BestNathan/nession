//! Tests for the Server-owned Session→Project membership (#3082).

use super::*;
use crate::db::{ProjectRow, SessionEnvBindingRow};
use crate::registry::session::{SessionInfo, SessionStatus};
use nession_protocol::contracts::project::v1::ProjectLocation;
use serde_json::{json, Value};

const PROJECT_ID: &str = "project-123e4567-e89b-42d3-a456-426614174000";
const OTHER_PROJECT_ID: &str = "project-123e4567-e89b-42d3-a456-426614174001";

async fn seed_project(h: &ConnectionHandler, project_id: &str) {
    h.db.insert_project(&ProjectRow {
        project_id: project_id.to_string(),
        name: "Fixtures".to_string(),
        description: None,
        source: None,
        locations: vec![ProjectLocation {
            agent_id: "a1".to_string(),
            path: "/srv/project".to_string(),
        }],
        session_defaults: None,
        image_digest: None,
        created_at: 1,
        updated_at: 1,
    })
    .await
    .unwrap();
}

async fn seed_session(h: &mut ConnectionHandler, name: &str) -> SessionInfo {
    let session = SessionInfo {
        session_id: format!("a1:{name}"),
        agent_id: "a1".to_string(),
        session_name: name.to_string(),
        status: SessionStatus::Active,
        window_count: 1,
        attached_clients: 0,
        foreground_command: None,
        working_dir: Some("/srv/project".to_string()),
        created_at: chrono::Utc::now(),
        last_activity: chrono::Utc::now(),
        instance_id: Some("instance-1".to_string()),
    };
    h.session_registry.update_session(session.clone()).await;
    session
}

async fn set_project(h: &mut ConnectionHandler, payload: Value) -> Value {
    parse_reply(
        h.handle_message(proto_msg("server.session.project.set", payload))
            .await
            .unwrap(),
    )
}

async fn list_sessions(h: &mut ConnectionHandler) -> Vec<Value> {
    let reply = parse_reply(
        h.handle_message(proto_msg("server.session.list", json!({})))
            .await
            .unwrap(),
    );
    reply["payload"]["sessions"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn project_id_for(sessions: &[Value], session_id: &str) -> Option<String> {
    sessions
        .iter()
        .find(|session| session["session_id"] == session_id)
        .and_then(|session| session.get("project_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[tokio::test]
async fn association_round_trips_and_projects_through_session_list() {
    let mut h = handler_with_online_agent().await;
    seed_project(&h, PROJECT_ID).await;
    seed_project(&h, OTHER_PROJECT_ID).await;
    let session = seed_session(&mut h, "s1").await;

    let associated = set_project(
        &mut h,
        json!({
            "session_id": session.session_id,
            "project_id": PROJECT_ID,
        }),
    )
    .await;
    assert_eq!(associated["payload"]["success"], true);
    assert_eq!(associated["payload"]["project_id"], PROJECT_ID);
    assert_eq!(associated["payload"]["revision"], 1);
    let binding =
        h.db.get_session_project_binding(&session.session_id)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(binding.project_id, PROJECT_ID);
    assert_eq!(binding.agent_created_at, session.created_at.timestamp());
    assert_eq!(
        project_id_for(&list_sessions(&mut h).await, &session.session_id).as_deref(),
        Some(PROJECT_ID)
    );

    // Change with the revision the caller just observed.
    let changed = set_project(
        &mut h,
        json!({
            "session_id": session.session_id,
            "project_id": OTHER_PROJECT_ID,
            "expected_revision": 1,
        }),
    )
    .await;
    assert_eq!(changed["payload"]["success"], true);
    assert_eq!(changed["payload"]["project_id"], OTHER_PROJECT_ID);
    assert_eq!(changed["payload"]["revision"], 2);

    let removed = set_project(
        &mut h,
        json!({
            "session_id": session.session_id,
            "project_id": null,
            "expected_revision": 2,
        }),
    )
    .await;
    assert_eq!(removed["payload"]["success"], true);
    assert!(removed["payload"].get("project_id").is_none());
    assert_eq!(removed["payload"]["revision"], 0);
    assert!(h
        .db
        .get_session_project_binding(&session.session_id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        project_id_for(&list_sessions(&mut h).await, &session.session_id),
        None
    );
    // A Session survives every membership edit.
    assert!(h.session_registry.get(&session.session_id).await.is_some());
}

#[tokio::test]
async fn association_is_authenticated_and_validates_entities() {
    let mut h = handler_with_online_agent().await;
    seed_project(&h, PROJECT_ID).await;
    let session = seed_session(&mut h, "s1").await;

    h.authenticated_client = false;
    let unauthenticated = set_project(
        &mut h,
        json!({ "session_id": session.session_id, "project_id": PROJECT_ID }),
    )
    .await;
    assert_eq!(unauthenticated["payload"]["error_kind"], "unauthorized");
    h.authenticated_client = true;

    let missing_session = set_project(
        &mut h,
        json!({ "session_id": "a1:missing", "project_id": PROJECT_ID }),
    )
    .await;
    assert_eq!(missing_session["payload"]["error_kind"], "not_found");

    let missing_project = set_project(
        &mut h,
        json!({
            "session_id": session.session_id,
            "project_id": "project-00000000-0000-4000-8000-000000000000",
        }),
    )
    .await;
    assert_eq!(missing_project["payload"]["error_kind"], "not_found");

    let malformed = set_project(
        &mut h,
        json!({ "session_id": "not-a-session", "project_id": PROJECT_ID }),
    )
    .await;
    assert_eq!(malformed["payload"]["error_kind"], "invalid");

    let malformed_project = set_project(
        &mut h,
        json!({ "session_id": session.session_id, "project_id": "nope" }),
    )
    .await;
    assert_eq!(malformed_project["payload"]["error_kind"], "invalid");
    assert!(h
        .db
        .get_session_project_binding(&session.session_id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn association_is_revision_guarded_and_never_touches_runtime_state() {
    let mut h = handler_with_online_agent().await;
    seed_project(&h, PROJECT_ID).await;
    let session = seed_session(&mut h, "s1").await;
    let env_binding = SessionEnvBindingRow {
        session_id: session.session_id.clone(),
        agent_id: "a1".to_string(),
        desired_revision: 7,
        profiles_json: "[]".to_string(),
        updated_at: 10,
    };
    h.db.upsert_session_env_binding(&env_binding).await.unwrap();
    let before = h
        .session_registry
        .get(&session.session_id)
        .await
        .expect("the Session is live");

    let associated = set_project(
        &mut h,
        json!({ "session_id": session.session_id, "project_id": PROJECT_ID }),
    )
    .await;
    assert_eq!(associated["payload"]["revision"], 1);

    let stale = set_project(
        &mut h,
        json!({
            "session_id": session.session_id,
            "project_id": PROJECT_ID,
            "expected_revision": 0,
        }),
    )
    .await;
    assert_eq!(stale["payload"]["error_kind"], "conflict");

    let after = h
        .session_registry
        .get(&session.session_id)
        .await
        .expect("membership edits never destroy the Session");
    assert_eq!(after.created_at, before.created_at);
    assert_eq!(after.working_dir, before.working_dir);
    let stored_env =
        h.db.get_session_env_binding(&session.session_id)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(stored_env.desired_revision, env_binding.desired_revision);
    assert_eq!(stored_env.profiles_json, env_binding.profiles_json);
    assert_eq!(stored_env.updated_at, env_binding.updated_at);
    assert_eq!(
        stored_env.agent_id, env_binding.agent_id,
        "membership edits never change the Session-owned ENV binding"
    );
}

#[tokio::test]
async fn project_delete_unbinds_sessions_without_deleting_them() {
    let mut h = handler_with_online_agent().await;
    seed_project(&h, PROJECT_ID).await;
    let session = seed_session(&mut h, "s1").await;
    let associated = set_project(
        &mut h,
        json!({ "session_id": session.session_id, "project_id": PROJECT_ID }),
    )
    .await;
    assert_eq!(associated["payload"]["success"], true);

    let deleted = parse_reply(
        h.handle_message(proto_msg(
            "server.project.delete",
            json!({ "project_id": PROJECT_ID }),
        ))
        .await
        .unwrap(),
    );
    assert_eq!(deleted["payload"]["success"], true);
    assert!(h
        .db
        .get_session_project_binding(&session.session_id)
        .await
        .unwrap()
        .is_none());
    assert!(h.session_registry.get(&session.session_id).await.is_some());
    assert_eq!(
        project_id_for(&list_sessions(&mut h).await, &session.session_id),
        None
    );
}

#[tokio::test]
async fn reconnect_cache_clear_preserves_membership() {
    let mut h = handler_with_online_agent().await;
    seed_project(&h, PROJECT_ID).await;
    let session = seed_session(&mut h, "s1").await;
    let associated = set_project(
        &mut h,
        json!({ "session_id": session.session_id, "project_id": PROJECT_ID }),
    )
    .await;
    assert_eq!(associated["payload"]["success"], true);

    // Reconnect/re-registration clears the Agent-reported cache, not the
    // durable membership.
    h.db.delete_sessions_by_agent("a1").await.unwrap();
    assert!(h
        .db
        .get_session_project_binding(&session.session_id)
        .await
        .unwrap()
        .is_some());

    h.session_registry.update_session(session.clone()).await;
    assert_eq!(
        project_id_for(&list_sessions(&mut h).await, &session.session_id).as_deref(),
        Some(PROJECT_ID)
    );
}

#[tokio::test]
async fn a_reused_session_name_does_not_inherit_membership() {
    let mut h = handler_with_online_agent().await;
    seed_project(&h, PROJECT_ID).await;
    let first = seed_session(&mut h, "s1").await;
    let associated = set_project(
        &mut h,
        json!({ "session_id": first.session_id, "project_id": PROJECT_ID }),
    )
    .await;
    assert_eq!(associated["payload"]["success"], true);

    // The Agent reports a new tmux Session with the same recyclable name.
    let mut replacement = first.clone();
    replacement.created_at = first.created_at + chrono::Duration::seconds(60);
    replacement.last_activity = replacement.created_at;
    replacement.instance_id = Some("instance-2".to_string());
    h.session_registry.update_session(replacement).await;

    assert!(
        h.db.get_session_project_binding(&first.session_id)
            .await
            .unwrap()
            .is_none(),
        "a new incarnation must not resurrect the previous Project"
    );
    assert_eq!(
        project_id_for(&list_sessions(&mut h).await, &first.session_id),
        None
    );
}
