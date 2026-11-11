//! Tests localized to the server_project_get_v1 handler (#3021).
//!
//! SC-06: an authorized detail read returns a stable identity and references
//! with zero Sessions present, and requires no Agent or Session binding.
use super::*;

async fn authenticate(h: &mut ConnectionHandler) {
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
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
async fn project_get_requires_auth() {
    let mut h = test_handler("tok").await;
    let payload = get(&mut h, "project-123e4567-e89b-42d3-a456-426614174000").await;
    assert_eq!(payload["success"], false);
    assert_eq!(payload["error_kind"], "unauthorized");
    assert_eq!(payload["error"], "Not authenticated");
}

#[tokio::test]
async fn project_get_rejects_a_malformed_identity() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    for invalid in [
        "",
        "not-a-project",
        "project-123",
        "123e4567-e89b-42d3-a456-426614174000",
    ] {
        let payload = get(&mut h, invalid).await;
        assert_eq!(payload["success"], false, "{payload}");
        assert_eq!(payload["error_kind"], "invalid", "{payload}");
        assert_eq!(
            payload["error"], "project_id is not a valid Project identity",
            "{payload}"
        );
    }
}

#[tokio::test]
async fn project_get_reports_not_found_without_a_session() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    assert!(h.session_registry.list().await.is_empty());
    let payload = get(&mut h, "project-00000000-0000-4000-8000-000000000000").await;
    assert_eq!(payload["success"], false);
    assert_eq!(payload["error_kind"], "not_found");
    assert_eq!(payload["error"], "Project not found");
    assert!(payload.get("project").is_none());
}

#[tokio::test]
async fn project_get_returns_the_same_identity_and_references_across_reads() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    let created = parse_reply(
        h.handle_message(proto_msg(
            "server.project.create",
            json!({
                "name": "Nession",
                "source": {
                    "repository_url": "https://github.com/BestNathan/nession.git",
                    "ref": "main"
                },
                "locations": [{ "agent_id": "offline-agent", "path": "/srv/nession" }]
            }),
        ))
        .await
        .unwrap(),
    )["payload"]["project"]
        .clone();
    let project_id = created["project_id"].as_str().unwrap().to_string();

    // No Agent is registered and no Session exists: the read still succeeds.
    assert!(h.session_registry.list().await.is_empty());
    let first = get(&mut h, &project_id).await;
    let second = get(&mut h, &project_id).await;
    assert_eq!(first, second);
    assert_eq!(first["success"], true);
    assert_eq!(first["project"]["project_id"], project_id);
    assert_eq!(first["project"]["source"]["ref"], "main");
    assert_eq!(
        first["project"]["locations"][0]["agent_id"],
        "offline-agent"
    );
}

#[tokio::test]
async fn project_get_reports_a_database_read_failure_as_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("projects.db");
    let db = Arc::new(Database::new(path.to_str().unwrap()).await.unwrap());

    let saboteur = sea_orm::Database::connect(format!("sqlite://{}?mode=rwc", path.display()))
        .await
        .unwrap();
    use sea_orm::ConnectionTrait;
    saboteur
        .execute_unprepared("DROP TABLE projects")
        .await
        .unwrap();
    saboteur.close().await.unwrap();

    let mut h = handler_with_db(db, "tok");
    authenticate(&mut h).await;

    let payload = get(&mut h, "project-123e4567-e89b-42d3-a456-426614174000").await;
    assert_eq!(payload["success"], false);
    assert_eq!(payload["error_kind"], "unavailable");
    let error = payload["error"].as_str().unwrap();
    assert!(!error.to_lowercase().contains("no such table"), "{error}");
}
