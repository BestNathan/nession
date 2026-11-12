//! Asynchronous image build units (#3334).
use super::*;

async fn build_handler(auth_token: &str) -> ConnectionHandler {
    let db = Arc::new(Database::new(":memory:").await.unwrap());
    let build_root = std::env::temp_dir().join(format!(
        "nession-image-build-handler-{}",
        uuid::Uuid::new_v4()
    ));
    TestDeps::with_db_and_builds(db, build_root).handler(auth_token)
}

/// Invoke one unit named by a literal in the caller's table.
async fn call(
    handler: &mut ConnectionHandler,
    wire: &str,
    payload: serde_json::Value,
) -> serde_json::Value {
    // not-protocol: every caller passes a literal wire from the table above
    parse_reply(
        handler
            .handle_message(proto_msg(wire, payload))
            .await
            .unwrap(),
    )["payload"]
        .clone()
}

#[tokio::test]
async fn every_build_unit_refuses_an_unauthenticated_caller() {
    for (wire, payload) in [
        (
            "server.image.build.submit",
            json!({"source": {"kind": "local_directory", "path": "/tmp/x"}}),
        ),
        ("server.image.build.get", json!({"build_id": "build-abc"})),
        ("server.image.build.list", json!({})),
        (
            "server.image.build.cancel",
            json!({"build_id": "build-abc"}),
        ),
        ("server.image.build.retry", json!({"build_id": "build-abc"})),
    ] {
        let mut h = test_handler("").await;
        let payload = call(&mut h, wire, payload).await;
        assert_eq!(payload["error"], "Not authenticated", "{wire}");
        assert_eq!(payload["error_kind"], "unauthorized", "{wire}");
    }
}

#[tokio::test]
async fn malformed_build_payloads_are_refused_with_the_shared_shape() {
    let mut h = build_handler("").await;
    h.authenticated_client = true;
    let payload = call(&mut h, "server.image.build.submit", json!({})).await;
    assert_eq!(
        payload["error"],
        "Malformed image payload: required fields are missing or have the wrong type"
    );
    assert_eq!(payload["error_kind"], "invalid");
    let payload = call(&mut h, "server.image.build.get", json!({"build_id": 7})).await;
    assert_eq!(payload["error_kind"], "invalid");
}

#[tokio::test]
async fn submit_returns_a_build_record_and_get_list_read_it_back() {
    let mut h = build_handler("").await;
    h.authenticated_client = true;
    let source = std::env::temp_dir().join(format!(
        "nession-image-build-source-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("file"), b"payload").unwrap();

    let submitted = call(
        &mut h,
        "server.image.build.submit",
        json!({
            "source": {"kind": "local_directory", "path": source.to_string_lossy()},
            "alias": "handler-build",
            "client_request_id": "handler-request-1",
        }),
    )
    .await;
    assert_eq!(submitted["success"], true, "{submitted}");
    let build_id = submitted["build"]["build_id"].as_str().unwrap().to_string();

    let duplicate = call(
        &mut h,
        "server.image.build.submit",
        json!({
            "source": {"kind": "local_directory", "path": source.to_string_lossy()},
            "alias": "handler-build",
            "client_request_id": "handler-request-1",
        }),
    )
    .await;
    assert_eq!(duplicate["build"]["build_id"], build_id);

    let read = call(
        &mut h,
        "server.image.build.get",
        json!({"build_id": build_id}),
    )
    .await;
    assert_eq!(read["success"], true, "{read}");
    assert_eq!(read["build"]["build_id"], build_id);

    let page = call(
        &mut h,
        "server.image.build.list",
        json!({"offset": 0, "limit": 10}),
    )
    .await;
    assert_eq!(page["total"], 1);
    assert_eq!(page["builds"][0]["build_id"], build_id);

    let unknown = call(
        &mut h,
        "server.image.build.get",
        json!({"build_id": "build-00000000-0000-4000-8000-000000000000"}),
    )
    .await;
    assert_eq!(unknown["error_kind"], "not_found");
    let invalid = call(
        &mut h,
        "server.image.build.get",
        json!({"build_id": "not-a-build"}),
    )
    .await;
    assert_eq!(invalid["error_kind"], "invalid");
}

#[tokio::test]
async fn a_failed_build_is_cancelable_and_retryable_through_the_units() {
    let mut h = build_handler("").await;
    h.authenticated_client = true;
    // A Git source is retryable even when no attempt produced a snapshot; the
    // unavailable backend fails each execution without touching the network.
    let build_id = call(
        &mut h,
        "server.image.build.submit",
        json!({
            "source": {
                "kind": "github",
                "repository_url": "https://github.com/BestNathan/nession",
                "ref": "main",
            },
        }),
    )
    .await["build"]["build_id"]
        .as_str()
        .unwrap()
        .to_string();

    // The unavailable backend fails every execution; wait for its terminal
    // record through the same durable get path a reconnecting client uses.
    let mut terminal = serde_json::Value::Null;
    for _ in 0..200 {
        let read = call(
            &mut h,
            "server.image.build.get",
            json!({"build_id": build_id}),
        )
        .await;
        let status = read["build"]["status"].as_str().unwrap_or_default();
        if status == "failed" || status == "canceled" || status == "succeeded" {
            terminal = read;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(terminal["build"]["status"], "failed", "{terminal}");
    assert!(terminal["build"]["error"].is_string());

    // Canceling a terminal build is idempotent.
    let canceled = call(
        &mut h,
        "server.image.build.cancel",
        json!({"build_id": build_id}),
    )
    .await;
    assert_eq!(canceled["success"], true, "{canceled}");
    assert_eq!(canceled["build"]["status"], "failed");

    let retried = call(
        &mut h,
        "server.image.build.retry",
        json!({"build_id": build_id}),
    )
    .await;
    assert_eq!(retried["success"], true, "{retried}");
    assert_eq!(retried["build"]["attempt"], 2);
}
