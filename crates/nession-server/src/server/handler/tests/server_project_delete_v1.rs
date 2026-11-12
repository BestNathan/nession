//! Tests localized to the server_project_delete_v1 handler (#3021).
//!
//! SC-03: deleting a Project removes only the declaration. Existing Locations
//! are user-owned host directories, image digests reference globally shared
//! artifacts, and Sessions are never cascaded.
use super::*;
use crate::registry::{SessionInfo, SessionStatus};

async fn authenticate(h: &mut ConnectionHandler) {
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
}

async fn create(h: &mut ConnectionHandler, payload: serde_json::Value) -> serde_json::Value {
    parse_reply(
        h.handle_message(proto_msg("server.project.create", payload))
            .await
            .unwrap(),
    )["payload"]["project"]
        .clone()
}

async fn delete(h: &mut ConnectionHandler, project_id: &str) -> serde_json::Value {
    parse_reply(
        h.handle_message(proto_msg(
            "server.project.delete",
            json!({ "project_id": project_id }),
        ))
        .await
        .unwrap(),
    )["payload"]
        .clone()
}

async fn get(h: &mut ConnectionHandler, project_id: &str) -> serde_json::Value {
    parse_reply(
        h.handle_message(proto_msg(
            "server.project.get",
            json!({ "project_id": project_id }),
        ))
        .await
        .unwrap(),
    )["payload"]
        .clone()
}

#[tokio::test]
async fn project_delete_requires_auth() {
    let mut h = test_handler("tok").await;
    let payload = delete(&mut h, "project-123e4567-e89b-42d3-a456-426614174000").await;
    assert_eq!(payload["success"], false);
    assert_eq!(payload["error_kind"], "unauthorized");
}

#[tokio::test]
async fn project_delete_rejects_a_malformed_identity() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    let payload = delete(&mut h, "not-a-project").await;
    assert_eq!(payload["success"], false);
    assert_eq!(payload["error_kind"], "invalid");
    assert_eq!(
        payload["error"],
        "project_id is not a valid Project identity"
    );
}

#[tokio::test]
async fn project_delete_reports_not_found() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    let payload = delete(&mut h, "project-00000000-0000-4000-8000-000000000000").await;
    assert_eq!(payload["success"], false);
    assert_eq!(payload["error_kind"], "not_found");
    assert_eq!(payload["error"], "Project not found");
}

#[tokio::test]
async fn project_delete_removes_only_the_declaration() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    // A real user-owned directory with real content. The Project references it.
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let file = work.join("notes.txt");
    std::fs::write(&file, "do not delete me").unwrap();

    let project = create(
        &mut h,
        json!({
            "name": "Existing directory",
            "locations": [{ "agent_id": "agent-a", "path": work.to_str().unwrap() }]
        }),
    )
    .await;
    let project_id = project["project_id"].as_str().unwrap().to_string();

    let payload = delete(&mut h, &project_id).await;
    assert_eq!(payload["success"], true, "{payload}");
    assert_eq!(get(&mut h, &project_id).await["error_kind"], "not_found");

    // The declaration is gone; the user's directory and file are not.
    assert!(
        work.is_dir(),
        "the Existing Location directory must survive"
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "do not delete me");
}

#[tokio::test]
async fn project_delete_does_not_remove_globally_shared_image_content() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    let digest = format!("sha256:{}", "b".repeat(64));
    let first = create(&mut h, json!({ "name": "First", "image_digest": digest })).await
        ["project_id"]
        .as_str()
        .unwrap()
        .to_string();
    let second = create(&mut h, json!({ "name": "Second", "image_digest": digest })).await
        ["project_id"]
        .as_str()
        .unwrap()
        .to_string();

    assert_eq!(delete(&mut h, &first).await["success"], true);

    // The shared digest reference on the other Project is untouched.
    let remaining = get(&mut h, &second).await;
    assert_eq!(remaining["success"], true);
    assert_eq!(remaining["project"]["image_digest"], digest);
}

#[tokio::test]
async fn project_delete_does_not_cascade_to_sessions() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    let project = create(&mut h, json!({ "name": "With session" })).await;
    let project_id = project["project_id"].as_str().unwrap().to_string();
    h.session_registry
        .update_session(SessionInfo {
            session_id: "agent-a:work".to_string(),
            agent_id: "agent-a".to_string(),
            session_name: "work".to_string(),
            status: SessionStatus::Detached,
            window_count: 1,
            attached_clients: 0,
            foreground_command: None,
            working_dir: None,
            instance_id: None,
            created_at: chrono::Utc::now(),
            last_activity: chrono::Utc::now(),
        })
        .await;

    assert_eq!(delete(&mut h, &project_id).await["success"], true);
    assert!(h.session_registry.get("agent-a:work").await.is_some());
}
