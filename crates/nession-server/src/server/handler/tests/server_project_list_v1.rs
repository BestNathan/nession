//! Tests localized to the server_project_list_v1 handler (#3021).
//!
//! SC-06: list is authorized and works with zero Sessions present; a failed
//! read is distinguishable from a genuinely empty collection.
use super::*;

async fn authenticate(h: &mut ConnectionHandler) {
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
}

async fn list(h: &mut ConnectionHandler) -> serde_json::Value {
    parse_reply(
        h.handle_message(proto_msg("server.project.list", json!({})))
            .await
            .unwrap(),
    )["payload"]
        .clone()
}

#[tokio::test]
async fn project_list_requires_auth() {
    let mut h = test_handler("tok").await;
    let payload = list(&mut h).await;
    assert_eq!(payload["error"], "Not authenticated");
    assert!(payload["projects"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn project_list_is_empty_but_successful_with_zero_sessions() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    // No Session was ever created; Projects do not require one.
    assert!(h.session_registry.list().await.is_empty());
    let payload = list(&mut h).await;
    assert!(payload["projects"].as_array().unwrap().is_empty());
    assert!(
        payload.get("error").is_none(),
        "a genuinely empty list must not look like a failed read: {payload}"
    );
}

#[tokio::test]
async fn project_list_returns_stable_identities_created_elsewhere() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    let first = parse_reply(
        h.handle_message(proto_msg(
            "server.project.create",
            json!({ "name": "First" }),
        ))
        .await
        .unwrap(),
    )["payload"]["project"]["project_id"]
        .as_str()
        .unwrap()
        .to_string();
    let second = parse_reply(
        h.handle_message(proto_msg(
            "server.project.create",
            json!({ "name": "Second" }),
        ))
        .await
        .unwrap(),
    )["payload"]["project"]["project_id"]
        .as_str()
        .unwrap()
        .to_string();

    let payload = list(&mut h).await;
    let ids: Vec<&str> = payload["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|project| project["project_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&first.as_str()));
    assert!(ids.contains(&second.as_str()));
    assert_ne!(first, second);

    // Reading again is stable: identities are never reassigned by a read.
    let again = list(&mut h).await;
    assert_eq!(again, payload);
}

/// A database that cannot answer `list` must not answer with an empty list.
#[tokio::test]
async fn project_list_reports_a_database_read_failure() {
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

    let payload = list(&mut h).await;
    let error = payload["error"]
        .as_str()
        .unwrap_or_else(|| panic!("a failed read must carry an error: {payload}"));
    assert!(payload["projects"].as_array().unwrap().is_empty());
    let lower = error.to_lowercase();
    assert!(
        !lower.contains("no such table") && !lower.contains("sqlite") && !lower.contains("sqlx"),
        "the reply must not leak database details: {error}"
    );
}
