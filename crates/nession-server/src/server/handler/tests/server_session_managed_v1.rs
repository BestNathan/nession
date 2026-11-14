//! Managed EROFS-backed Session creation (#3062).
use super::*;
use nession_protocol::contracts::image::v1::{ImagePackaging, ImageSource};

const PROJECT: &str = "project-00000000-0000-0000-0000-000000000062";
const BASE_DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKSPACE_DIGEST: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SOURCE_SHA: &str = "0123456789abcdef0123456789abcdef01234567";

fn image_row(
    image_id: &str,
    digest: &str,
    status: &str,
    source_sha: Option<&str>,
) -> crate::db::ImageRow {
    crate::db::ImageRow {
        image_id: image_id.to_string(),
        digest: Some(digest.to_string()),
        size_bytes: 128,
        source_json: serde_json::to_string(&ImageSource::LocalDirectory {
            path: "/fixture".to_string(),
        })
        .unwrap(),
        source_sha: source_sha.map(str::to_string),
        packaging_json: serde_json::to_string(&ImagePackaging::default()).unwrap(),
        status: status.to_string(),
        error: None,
        created_at: 1,
        updated_at: 1,
    }
}

async fn managed_deps(workspace_digest: Option<&str>) -> TestDeps {
    let deps = TestDeps::new().await;
    deps.db
        .insert_project(&crate::db::ProjectRow {
            project_id: PROJECT.to_string(),
            name: "Managed".to_string(),
            description: None,
            source: None,
            locations: Vec::new(),
            session_defaults: None,
            image_digest: workspace_digest.map(str::to_string),
            created_at: 1,
            updated_at: 1,
        })
        .await
        .unwrap();
    deps
}

/// `server.session.create` answered by a fake Agent. Returns the reply plus
/// the request payload the Agent received.
async fn create_with_agent(
    h: &mut ConnectionHandler,
    name: &str,
    agent_response: serde_json::Value,
) -> (serde_json::Value, serde_json::Value) {
    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    let broker = Arc::clone(&h.command_broker);
    let create = h.handle_message(proto_msg(
        "server.session.create",
        json!({
            "agent_id": "a1",
            "name": name,
            "project_id": PROJECT,
            "managed": { "base_digest": BASE_DIGEST }
        }),
    ));
    let agent = async move {
        let wire = rx.recv().await.expect("Agent receives the managed create");
        let request: serde_json::Value =
            serde_json::from_str(wire.message.to_text().unwrap()).unwrap();
        let request_id = request["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        broker
            .resolve_command("a1", &request_id, agent_response)
            .await;
        request
    };
    // Bounded: a create refused before it reaches the Agent never answers the
    // fake Agent's `recv`, and an unbounded join would hang the suite instead
    // of failing the test.
    let (action, request) = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        tokio::join!(create, agent)
    })
    .await
    .expect("managed create reached the Agent");
    (parse_reply(action.unwrap()), request)
}

#[tokio::test]
async fn managed_create_pins_and_authorizes_every_artifact() {
    let deps = managed_deps(Some(WORKSPACE_DIGEST)).await;
    deps.db
        .insert_image(&image_row(
            "image-w",
            WORKSPACE_DIGEST,
            "ready",
            Some(SOURCE_SHA),
        ))
        .await
        .unwrap();
    deps.db
        .insert_image(&image_row("image-b", BASE_DIGEST, "ready", None))
        .await
        .unwrap();
    let mut h = deps.handler("");
    h.authenticated_client = true;
    register_agent_id(&h, "a1", None).await;

    let (reply, request) = create_with_agent(
        &mut h,
        "managed-1",
        json!({ "success": true, "workspace": "/state/managed/x/workspace" }),
    )
    .await;

    assert_eq!(reply["payload"]["success"], json!(true));
    assert_eq!(reply["payload"]["project_id"], json!(PROJECT));
    // A managed Session's cwd is inside the prepared composition.
    assert_eq!(request["payload"]["working_dir"], serde_json::Value::Null);
    assert!(request["payload"]["sandbox"].is_null());
    let images = request["payload"]["managed"]["images"].as_array().unwrap();
    assert_eq!(images.len(), 2);
    assert_eq!(images[0]["role"], json!("base"));
    assert_eq!(images[0]["digest"], json!(BASE_DIGEST));
    assert_eq!(images[1]["role"], json!("workspace"));
    assert_eq!(images[1]["digest"], json!(WORKSPACE_DIGEST));
    assert_eq!(
        images[0]["path"],
        json!(format!("/images/blobs/{BASE_DIGEST}"))
    );
    // The Agent fetches these routes with the durable Agent Token it already
    // holds; a per-artifact bearer is gone (#3440).
    assert!(
        images[0].get("token").is_none(),
        "a managed artifact carries no minted credential: {}",
        images[0]
    );
    assert_eq!(
        images[1]["path"],
        json!(format!("/images/blobs/{WORKSPACE_DIGEST}"))
    );

    let context =
        h.db.get_session_managed_context("a1:managed-1")
            .await
            .unwrap()
            .expect("managed context recorded");
    assert_eq!(context.status, "ready");
    assert_eq!(context.project_id, PROJECT);
    assert_eq!(context.base_digest, BASE_DIGEST);
    assert_eq!(context.workspace_digest, WORKSPACE_DIGEST);
    assert_eq!(context.source_sha.as_deref(), Some(SOURCE_SHA));
    assert_eq!(
        context.workspace.as_deref(),
        Some("/state/managed/x/workspace")
    );
}

#[tokio::test]
async fn a_managed_create_without_a_pinned_project_image_is_refused() {
    let deps = managed_deps(None).await;
    let mut h = deps.handler("");
    h.authenticated_client = true;
    register_agent_id(&h, "a1", None).await;
    let action = h
        .handle_message(proto_msg(
            "server.session.create",
            json!({
                "agent_id": "a1",
                "name": "managed-1",
                "project_id": PROJECT,
                "managed": { "base_digest": BASE_DIGEST }
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], json!(false));
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("does not pin an EROFS image"));
    assert!(h
        .db
        .get_session_managed_context("a1:managed-1")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn a_managed_create_with_a_non_ready_artifact_is_refused() {
    let deps = managed_deps(Some(WORKSPACE_DIGEST)).await;
    deps.db
        .insert_image(&image_row(
            "image-w",
            WORKSPACE_DIGEST,
            "ready",
            Some(SOURCE_SHA),
        ))
        .await
        .unwrap();
    deps.db
        .insert_image(&image_row("image-b", BASE_DIGEST, "building", None))
        .await
        .unwrap();
    let mut h = deps.handler("");
    h.authenticated_client = true;
    register_agent_id(&h, "a1", None).await;
    let action = h
        .handle_message(proto_msg(
            "server.session.create",
            json!({
                "agent_id": "a1",
                "name": "managed-1",
                "project_id": PROJECT,
                "managed": { "base_digest": BASE_DIGEST }
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], json!(false));
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not ready"));
}

#[tokio::test]
async fn a_refused_managed_create_records_a_truthful_failed_context() {
    let deps = managed_deps(Some(WORKSPACE_DIGEST)).await;
    deps.db
        .insert_image(&image_row(
            "image-w",
            WORKSPACE_DIGEST,
            "ready",
            Some(SOURCE_SHA),
        ))
        .await
        .unwrap();
    deps.db
        .insert_image(&image_row("image-b", BASE_DIGEST, "ready", None))
        .await
        .unwrap();
    let mut h = deps.handler("");
    h.authenticated_client = true;
    register_agent_id(&h, "a1", None).await;

    let (reply, _) = create_with_agent(
        &mut h,
        "managed-1",
        json!({ "success": false, "error": "this Agent has no EROFS cache configured" }),
    )
    .await;
    assert_eq!(reply["payload"]["success"], json!(false));
    assert_eq!(
        reply["payload"]["error"],
        json!("this Agent has no EROFS cache configured")
    );

    let context =
        h.db.get_session_managed_context("a1:managed-1")
            .await
            .unwrap()
            .expect("a refused attempt is still recorded");
    assert_eq!(context.status, "failed");
    assert_eq!(
        context.error.as_deref(),
        Some("this Agent has no EROFS cache configured")
    );
}

#[tokio::test]
async fn a_stale_managed_attempt_cannot_overwrite_the_winner() {
    let deps = managed_deps(Some(WORKSPACE_DIGEST)).await;
    let row = |attempt: &str| crate::db::SessionManagedContextRow {
        session_id: "a1:managed-1".to_string(),
        agent_id: "a1".to_string(),
        project_id: PROJECT.to_string(),
        attempt_id: attempt.to_string(),
        base_digest: BASE_DIGEST.to_string(),
        workspace_digest: WORKSPACE_DIGEST.to_string(),
        toolchains: Vec::new(),
        source_sha: Some(SOURCE_SHA.to_string()),
        workspace: None,
        status: "preparing".to_string(),
        error: None,
        updated_at: 1,
    };

    deps.db
        .begin_session_managed_context(&row("attempt-a"))
        .await
        .unwrap();
    assert!(deps
        .db
        .mark_session_managed_context_ready("a1:managed-1", "attempt-a", Some("/a"))
        .await
        .unwrap());

    // A second attempt takes ownership; the first attempt's late failure must
    // not overwrite the newer attempt's disposition.
    deps.db
        .begin_session_managed_context(&row("attempt-b"))
        .await
        .unwrap();
    assert!(!deps
        .db
        .mark_session_managed_context_failed("a1:managed-1", "attempt-a", "late failure")
        .await
        .unwrap());
    assert!(deps
        .db
        .mark_session_managed_context_ready("a1:managed-1", "attempt-b", Some("/b"))
        .await
        .unwrap());

    let context = deps
        .db
        .get_session_managed_context("a1:managed-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(context.status, "ready");
    assert_eq!(context.workspace.as_deref(), Some("/b"));
    assert!(context.error.is_none());
}

/// A refused Managed attempt leaves a truthful failed context, and the same
/// name can be retried. The retry owns a fresh attempt id and reaches ready;
/// it never inherits the failed attempt's disposition.
#[tokio::test]
async fn a_failed_managed_create_is_retryable() {
    let deps = managed_deps(Some(WORKSPACE_DIGEST)).await;
    deps.db
        .insert_image(&image_row(
            "image-w",
            WORKSPACE_DIGEST,
            "ready",
            Some(SOURCE_SHA),
        ))
        .await
        .unwrap();
    deps.db
        .insert_image(&image_row("image-b", BASE_DIGEST, "ready", None))
        .await
        .unwrap();
    let mut h = deps.handler("");
    h.authenticated_client = true;
    register_agent_id(&h, "a1", None).await;

    let (refused, _) = create_with_agent(
        &mut h,
        "managed-1",
        json!({ "success": false, "error": "image transfer failed" }),
    )
    .await;
    assert_eq!(refused["payload"]["success"], json!(false));
    let failed =
        h.db.get_session_managed_context("a1:managed-1")
            .await
            .unwrap()
            .expect("the refused attempt is recorded");
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.error.as_deref(), Some("image transfer failed"));

    let (retry, _) = create_with_agent(
        &mut h,
        "managed-1",
        json!({ "success": true, "workspace": "/state/managed/y/workspace" }),
    )
    .await;
    assert_eq!(retry["payload"]["success"], json!(true));

    let ready =
        h.db.get_session_managed_context("a1:managed-1")
            .await
            .unwrap()
            .expect("the retry's context is recorded");
    assert_eq!(ready.status, "ready");
    assert_eq!(
        ready.workspace.as_deref(),
        Some("/state/managed/y/workspace")
    );
    assert!(ready.error.is_none(), "ready is not a failed disposition");
    assert_ne!(
        ready.attempt_id, failed.attempt_id,
        "the retry is a new attempt, not the failed one resurfacing"
    );
}

/// A same-named create against an already-ready Managed Session is refused
/// before the Agent is asked: the live attempt keeps its context, workspace
/// and attempt id, and no duplicate Session can be requested.
#[tokio::test]
async fn a_ready_managed_session_is_not_recreated_by_a_same_named_attempt() {
    let deps = managed_deps(Some(WORKSPACE_DIGEST)).await;
    deps.db
        .insert_image(&image_row(
            "image-w",
            WORKSPACE_DIGEST,
            "ready",
            Some(SOURCE_SHA),
        ))
        .await
        .unwrap();
    deps.db
        .insert_image(&image_row("image-b", BASE_DIGEST, "ready", None))
        .await
        .unwrap();
    let mut h = deps.handler("");
    h.authenticated_client = true;
    register_agent_id(&h, "a1", None).await;

    let (created, _) = create_with_agent(
        &mut h,
        "managed-1",
        json!({ "success": true, "workspace": "/state/managed/x/workspace" }),
    )
    .await;
    assert_eq!(created["payload"]["success"], json!(true));
    let before =
        h.db.get_session_managed_context("a1:managed-1")
            .await
            .unwrap()
            .expect("the winner's context is recorded");
    assert_eq!(before.status, "ready");

    // The refusal is local to the Server; no Agent command is sent, so this
    // must not wait on one.
    let action = h
        .handle_message(proto_msg(
            "server.session.create",
            json!({
                "agent_id": "a1",
                "name": "managed-1",
                "project_id": PROJECT,
                "managed": { "base_digest": BASE_DIGEST }
            }),
        ))
        .await
        .unwrap();
    let refused = parse_reply(action);
    assert_eq!(refused["payload"]["success"], json!(false));
    assert!(refused["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("ready Managed context"));

    let after =
        h.db.get_session_managed_context("a1:managed-1")
            .await
            .unwrap()
            .expect("the winner's context survives the refused attempt");
    assert_eq!(after.status, "ready");
    assert_eq!(after.attempt_id, before.attempt_id);
    assert_eq!(after.workspace, before.workspace);
}

/// Deleting one Managed Session removes only that Session's managed context:
/// another Session's context, its workspace and the shared image rows remain.
#[tokio::test]
async fn deleting_one_managed_context_keeps_another_sessions() {
    let deps = managed_deps(Some(WORKSPACE_DIGEST)).await;
    deps.db
        .insert_image(&image_row(
            "image-w",
            WORKSPACE_DIGEST,
            "ready",
            Some(SOURCE_SHA),
        ))
        .await
        .unwrap();
    deps.db
        .insert_image(&image_row("image-b", BASE_DIGEST, "ready", None))
        .await
        .unwrap();
    let mut h = deps.handler("");
    h.authenticated_client = true;
    register_agent_id(&h, "a1", None).await;

    for (name, workspace) in [
        ("managed-a", "/state/managed/a/workspace"),
        ("managed-b", "/state/managed/b/workspace"),
    ] {
        let (reply, _) = create_with_agent(
            &mut h,
            name,
            json!({ "success": true, "workspace": workspace }),
        )
        .await;
        assert_eq!(reply["payload"]["success"], json!(true));
    }
    assert!(h
        .db
        .get_session_managed_context("a1:managed-a")
        .await
        .unwrap()
        .is_some());

    h.session_registry.remove("a1:managed-a").await;

    assert!(
        h.db.get_session_managed_context("a1:managed-a")
            .await
            .unwrap()
            .is_none(),
        "the deleted Session's managed context is gone"
    );
    let kept =
        h.db.get_session_managed_context("a1:managed-b")
            .await
            .unwrap()
            .expect("the other Session's managed context survives");
    assert_eq!(kept.status, "ready");
    assert_eq!(
        kept.workspace.as_deref(),
        Some("/state/managed/b/workspace")
    );
    let image =
        h.db.get_image_by_digest(BASE_DIGEST)
            .await
            .unwrap()
            .expect("the shared image row is not Session-owned");
    assert_eq!(image.status, "ready");
}
