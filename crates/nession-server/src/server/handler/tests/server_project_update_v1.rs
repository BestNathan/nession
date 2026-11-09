//! Tests localized to the server_project_update_v1 handler (#3021).
//!
//! Update is a whole replacement of the mutable declaration: an edit can
//! rename, add/remove locations and clear an optional source or digest, while
//! the Server-owned identity and creation time are never reassigned.
use super::*;

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
    )["payload"]
        .clone()
}

async fn update(h: &mut ConnectionHandler, payload: serde_json::Value) -> serde_json::Value {
    parse_reply(
        h.handle_message(proto_msg("server.project.update", payload))
            .await
            .unwrap(),
    )["payload"]
        .clone()
}

#[tokio::test]
async fn project_update_requires_auth() {
    let mut h = test_handler("tok").await;
    let payload = update(
        &mut h,
        json!({
            "project_id": "project-123e4567-e89b-42d3-a456-426614174000",
            "name": "Renamed"
        }),
    )
    .await;
    assert_eq!(payload["success"], false);
    assert_eq!(payload["error_kind"], "unauthorized");
}

#[tokio::test]
async fn project_update_rejects_a_malformed_identity() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    let payload = update(&mut h, json!({ "project_id": "nope", "name": "Renamed" })).await;
    assert_eq!(payload["success"], false);
    assert_eq!(payload["error_kind"], "invalid");
    assert_eq!(
        payload["error"],
        "project_id is not a valid Project identity"
    );
}

#[tokio::test]
async fn project_update_reports_not_found() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    let payload = update(
        &mut h,
        json!({
            "project_id": "project-00000000-0000-4000-8000-000000000000",
            "name": "Renamed"
        }),
    )
    .await;
    assert_eq!(payload["success"], false);
    assert_eq!(payload["error_kind"], "not_found");
    assert_eq!(payload["error"], "Project not found");
}

#[tokio::test]
async fn project_update_replaces_the_whole_declaration_and_preserves_identity() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    let digest = format!("sha256:{}", "a".repeat(64));
    let created = create(
        &mut h,
        json!({
            "name": "Original",
            "description": "before",
            "source": {
                "repository_url": "https://github.com/BestNathan/nession.git",
                "ref": "main"
            },
            "locations": [{ "agent_id": "agent-a", "path": "/srv/nession" }],
            "session_defaults": { "shell": "/bin/zsh" },
            "image_digest": digest
        }),
    )
    .await["project"]
        .clone();
    let project_id = created["project_id"].as_str().unwrap().to_string();
    let created_at = created["created_at"].clone();

    let payload = update(
        &mut h,
        json!({
            "project_id": project_id,
            "name": "Renamed",
            "locations": [{ "agent_id": "agent-b", "path": "/workspace/nession" }]
        }),
    )
    .await;

    assert_eq!(payload["success"], true, "{payload}");
    let updated = &payload["project"];
    assert_eq!(updated["project_id"], project_id);
    assert_eq!(updated["created_at"], created_at);
    assert_eq!(updated["name"], "Renamed");
    // Absent optional fields clear; this is a whole replacement.
    assert!(updated.get("description").is_none(), "{updated}");
    assert!(updated.get("source").is_none(), "{updated}");
    assert!(updated.get("session_defaults").is_none(), "{updated}");
    assert!(updated.get("image_digest").is_none(), "{updated}");
    assert_eq!(updated["locations"][0]["agent_id"], "agent-b");
}

#[tokio::test]
async fn project_update_rejects_invalid_data_without_changing_the_stored_project() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    let created = create(&mut h, json!({ "name": "Stable" })).await["project"].clone();
    let project_id = created["project_id"].as_str().unwrap().to_string();

    for (payload, expected) in [
        (
            json!({
                "project_id": project_id,
                "name": "Stable",
                "source": { "repository_url": "not a url", "ref": "main" }
            }),
            "repository_url must be an https, ssh or git URL, or a user@host:path form",
        ),
        (
            json!({
                "project_id": project_id,
                "name": "Stable",
                "locations": [{ "agent_id": "a", "path": "relative" }]
            }),
            "location 1 path must be absolute",
        ),
    ] {
        let payload = update(&mut h, payload).await;
        assert_eq!(payload["success"], false, "{payload}");
        assert_eq!(payload["error_kind"], "invalid");
        assert_eq!(payload["error"], expected);
    }

    let stored = parse_reply(
        h.handle_message(proto_msg(
            "server.project.get",
            json!({ "project_id": project_id }),
        ))
        .await
        .unwrap(),
    )["payload"]["project"]
        .clone();
    assert_eq!(stored, created, "a rejected update must not mutate storage");
}
