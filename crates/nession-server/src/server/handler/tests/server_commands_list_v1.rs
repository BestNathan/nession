//! Tests localized to the server_commands_list_v1 handler (Issue #1258).
use super::*;
use nession_protocol::contracts::commands::v1::ClientCommandsListResponsePayload;

/// Authenticate this connection the way the wire does.
async fn authenticate(h: &mut ConnectionHandler) {
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
}

/// Ask for the saved commands and return the reply payload.
async fn list_payload(h: &mut ConnectionHandler) -> serde_json::Value {
    let action = h
        .handle_message(proto_msg("server.commands.list", json!({})))
        .await
        .unwrap();
    parse_reply(action)["payload"].clone()
}

#[tokio::test]
async fn commands_list_requires_auth() {
    let mut h = test_handler("tok").await;
    let action = h
        .handle_message(proto_msg("server.commands.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["msg_type"], "server.commands.list");
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("Not authenticated"));
}

#[tokio::test]
async fn commands_list_empty() {
    let mut h = test_handler("tok").await;
    // Auth as client first
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
    let action = h
        .handle_message(proto_msg("server.commands.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["msg_type"], "server.commands.list");
    assert!(reply["payload"]["commands"].as_array().unwrap().is_empty());
    // A valid empty list is a success: there is nothing to report.
    assert!(
        reply["payload"].get("error").is_none(),
        "a genuinely empty list must not look like a failed read: {}",
        reply["payload"]
    );
}

/// A database that cannot answer `list` must not answer with an empty list.
///
/// The defect (#2784): the handler `unwrap_or_default()`-ed the DAO result, so
/// a database fault produced exactly the reply a user with no saved commands
/// gets — `{ "commands": [] }`. The Web then marked the view `ready`, and
/// Retry could never activate.
#[tokio::test]
async fn commands_list_reports_a_database_read_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("commands.db");
    let db = Arc::new(Database::new(path.to_str().unwrap()).await.unwrap());

    // A second, independent connection removes the table out from under the
    // server's Database. That is a controlled read failure: the schema no
    // longer answers `list`, while the Database handle stays usable.
    let saboteur = sea_orm::Database::connect(format!("sqlite://{}?mode=rwc", path.display()))
        .await
        .unwrap();
    use sea_orm::ConnectionTrait;
    saboteur
        .execute_unprepared("DROP TABLE quick_commands")
        .await
        .unwrap();
    saboteur.close().await.unwrap();

    let mut h = handler_with_db(db, "tok");
    authenticate(&mut h).await;

    let payload = list_payload(&mut h).await;
    let error = payload["error"]
        .as_str()
        .unwrap_or_else(|| panic!("a failed read must carry an error: {payload}"));
    assert!(!error.is_empty(), "the error must say something");
    assert!(
        payload["commands"].as_array().unwrap().is_empty(),
        "a failed read must not fabricate rows: {payload}"
    );
    // The user-facing string is generic; the SQL error stays in the log.
    let lower = error.to_lowercase();
    assert!(
        !lower.contains("no such table") && !lower.contains("sqlite") && !lower.contains("sqlx"),
        "the reply must not leak SQL details: {error}"
    );

    // The wire shape is the versioned contract, not an ad-hoc object.
    let failure: ClientCommandsListResponsePayload = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| panic!("the failure reply must match its contract: {e}\n{payload}"));
    assert_eq!(failure.error.as_deref(), Some(error));
}

/// The counterexample: the same wiring over a healthy database.
#[tokio::test]
async fn commands_list_valid_empty_list_is_not_a_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("commands.db");
    let db = Arc::new(Database::new(path.to_str().unwrap()).await.unwrap());

    let mut h = handler_with_db(db, "tok");
    authenticate(&mut h).await;

    let payload = list_payload(&mut h).await;
    assert!(
        payload["commands"].as_array().unwrap().is_empty(),
        "no saved commands yet: {payload}"
    );
    assert!(
        payload.get("error").is_none(),
        "a valid empty list is not a failure: {payload}"
    );
    let success: ClientCommandsListResponsePayload = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| panic!("the success reply must match its contract: {e}\n{payload}"));
    assert!(success.commands.is_empty());
    assert!(
        success.error.is_none(),
        "the contract keeps `error` absent on a successful read"
    );
}
