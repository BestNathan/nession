//! Tests localized to the server_project_create_v1 handler (#3021).
//!
//! SC-01: a Project with only a name persists and is readable through the
//! versioned API, and invalid URL/ref/path/identity data is rejected
//! deterministically. SC-02: an absent Git source or an offline Agent never
//! prevents persistence.
use super::*;
use nession_protocol::contracts::project::v1::is_valid_project_id;

async fn authenticate(h: &mut ConnectionHandler) {
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
}

async fn create(h: &mut ConnectionHandler, payload: serde_json::Value) -> serde_json::Value {
    let action = h
        .handle_message(proto_msg("server.project.create", payload))
        .await
        .unwrap();
    parse_reply(action)["payload"].clone()
}

#[tokio::test]
async fn project_create_requires_auth() {
    let mut h = test_handler("tok").await;
    let payload = create(&mut h, json!({ "name": "Notes" })).await;
    assert_eq!(payload["success"], false);
    assert_eq!(payload["error_kind"], "unauthorized");
    assert_eq!(payload["error"], "Not authenticated");
}

#[tokio::test]
async fn project_create_with_name_only_persists() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    let payload = create(&mut h, json!({ "name": "  Notes  " })).await;
    assert_eq!(payload["success"], true, "{payload}");
    let project = &payload["project"];
    assert_eq!(project["name"], "Notes");
    assert!(project["project_id"]
        .as_str()
        .is_some_and(is_valid_project_id));
    assert!(project.get("source").is_none());
    assert_eq!(project["locations"].as_array().unwrap().len(), 0);
    assert!(project.get("session_defaults").is_none());
    assert!(project.get("image_digest").is_none());

    // The reply is the stored row: a detail read returns the same identity.
    let project_id = project["project_id"].as_str().unwrap();
    let get = parse_reply(
        h.handle_message(proto_msg(
            "server.project.get",
            json!({ "project_id": project_id }),
        ))
        .await
        .unwrap(),
    )["payload"]
        .clone();
    assert_eq!(get["success"], true);
    assert_eq!(get["project"]["project_id"], project_id);
}

#[tokio::test]
async fn project_create_accepts_source_locations_defaults_and_digest() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    let digest = format!("sha256:{}", "a".repeat(64));
    let payload = create(
        &mut h,
        json!({
            "name": "Nession",
            "description": "Workspace for Nession",
            "source": {
                "repository_url": "git@github.com:BestNathan/nession.git",
                "ref": "main"
            },
            "locations": [
                { "agent_id": "offline-agent", "path": "/srv/nession" },
                { "agent_id": "another-agent", "path": "/workspace/nession" }
            ],
            "session_defaults": {
                "shell": "/bin/zsh",
                "env_profile_ids": ["dev", "prod"],
                "sandbox_policy_ref": "sandbox/default"
            },
            "image_digest": digest
        }),
    )
    .await;

    assert_eq!(payload["success"], true, "{payload}");
    let project = &payload["project"];
    assert_eq!(
        project["source"]["repository_url"],
        "git@github.com:BestNathan/nession.git"
    );
    assert_eq!(project["source"]["ref"], "main");
    assert_eq!(project["locations"].as_array().unwrap().len(), 2);
    assert_eq!(project["locations"][0]["agent_id"], "offline-agent");
    assert_eq!(project["session_defaults"]["env_profile_ids"][1], "prod");
    assert_eq!(project["image_digest"], digest);
}

#[tokio::test]
async fn project_create_rejects_invalid_data_deterministically() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    for (payload, expected) in [
        (
            json!({ "name": "" }),
            "project name must not be empty".to_string(),
        ),
        (
            json!({
                "name": "P",
                "source": { "repository_url": "file:///tmp/repo", "ref": "main" }
            }),
            "repository_url must be an https, ssh or git URL, or a user@host:path form".to_string(),
        ),
        (
            json!({
                "name": "P",
                "source": { "repository_url": "https://example.com/repo.git", "ref": "bad ref" }
            }),
            "source ref is not a valid branch or commit".to_string(),
        ),
        (
            json!({
                "name": "P",
                "locations": [{ "agent_id": "a", "path": "relative/path" }]
            }),
            "location 1 path must be absolute".to_string(),
        ),
        (
            json!({
                "name": "P",
                "locations": [{ "agent_id": "a", "path": "/srv/../etc" }]
            }),
            "location 1 path must not contain '..'".to_string(),
        ),
        (
            json!({ "name": "P", "image_digest": "sha256:abc" }),
            "image_digest must be a sha256:<64 lowercase hex> digest".to_string(),
        ),
    ] {
        let reply = create(&mut h, payload).await;
        assert_eq!(reply["success"], false, "{reply}");
        assert_eq!(reply["error_kind"], "invalid", "{reply}");
        assert_eq!(reply["error"], expected, "{reply}");
        assert!(reply.get("project").is_none(), "{reply}");
    }

    // None of the rejected creates persisted anything.
    let list = parse_reply(
        h.handle_message(proto_msg("server.project.list", json!({})))
            .await
            .unwrap(),
    )["payload"]
        .clone();
    assert!(list["projects"].as_array().unwrap().is_empty(), "{list}");
}

#[tokio::test]
async fn project_create_rejects_a_malformed_payload() {
    let mut h = test_handler("tok").await;
    authenticate(&mut h).await;

    let reply = create(&mut h, json!({ "locations": [] })).await;
    assert_eq!(reply["success"], false);
    assert_eq!(reply["error_kind"], "invalid");
    assert!(reply["error"]
        .as_str()
        .unwrap()
        .contains("Malformed project payload"));
}
