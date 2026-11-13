//! Tests localized to the Sandbox context-capability units (#3124).
use super::*;
use crate::registry::session::{SessionInfo, SessionStatus};
use crate::server::outbound::WsMessageSender;

async fn register_session(h: &ConnectionHandler, session_id: &str) {
    let (agent_id, session_name) = session_id.split_once(':').expect("agent:name");
    let now = chrono::Utc::now();
    h.session_registry
        .insert_session_if_absent(SessionInfo {
            session_id: session_id.to_string(),
            agent_id: agent_id.to_string(),
            session_name: session_name.to_string(),
            status: SessionStatus::Detached,
            window_count: 1,
            attached_clients: 0,
            foreground_command: None,
            working_dir: None,
            instance_id: None,
            created_at: now,
            last_activity: now,
        })
        .await;
}

fn context_payload() -> serde_json::Value {
    json!({
        "status": "outside",
        "scope": {
            "session_name": "s1",
            "session_instance_id": "instance-1",
            "pane_id": "%1",
            "window_id": "@1",
            "pane_pid": 42,
            "working_dir": "/workspace",
        },
        "generation": "gen-1",
        "enterable": true,
        "sandbox_panes": [],
        "catalog": {
            "status": "available",
            "platform": "linux",
            "backend": "linux-bwrap",
            "probe_generation": "probe-1",
            "source": "agent-host-probe",
            "resource_fields": [],
            "syscall_fields": [],
        },
    })
}

/// Claim the command channel and answer one Server→Agent frame.
async fn answer_agent_frame(
    rx: &mut tokio::sync::mpsc::Receiver<crate::server::outbound::QueuedFrame>,
    broker: &Arc<crate::server::command_broker::CommandBroker>,
    expected_wire: &str,
    response: serde_json::Value,
) -> serde_json::Value {
    let text = rx
        .recv()
        .await
        .expect("Agent receives the capability command")
        .message
        .to_text()
        .unwrap()
        .to_string();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["msg_type"], expected_wire);
    let request_id = parsed["payload"]["request_id"].as_str().unwrap();
    broker.resolve_command("a1", request_id, response).await;
    parsed
}

async fn claim_agent(
    h: &ConnectionHandler,
) -> (
    Arc<crate::server::command_broker::CommandBroker>,
    tokio::sync::mpsc::Receiver<crate::server::outbound::QueuedFrame>,
) {
    let (sender, rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    (Arc::clone(&h.command_broker), rx)
}

#[tokio::test]
async fn context_refuses_an_unauthenticated_client() {
    let mut h = test_handler("").await;
    let reply = parse_reply(
        h.handle_message(proto_msg(
            "server.session.sandbox.context",
            json!({ "session_id": "a1:s1" }),
        ))
        .await
        .unwrap(),
    );
    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn context_requires_a_registered_session() {
    let mut h = handler_with_online_agent().await;
    let reply = parse_reply(
        h.handle_message(proto_msg(
            "server.session.sandbox.context",
            json!({ "session_id": "a1:missing" }),
        ))
        .await
        .unwrap(),
    );
    assert_eq!(reply["payload"]["success"], false);
    assert!(
        reply["payload"]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("not found"),
        "{reply}"
    );
}

#[tokio::test]
async fn context_relays_the_agent_observation_for_the_named_session_only() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    let (broker, mut rx) = claim_agent(&h).await;

    let handled = h.handle_message(proto_msg(
        "server.session.sandbox.context",
        json!({ "session_id": "a1:s1" }),
    ));
    let agent = async move {
        answer_agent_frame(
            &mut rx,
            &broker,
            "agent.session.sandbox.context",
            json!({ "success": true, "context": context_payload() }),
        )
        .await
    };
    let (action, sent) = tokio::join!(handled, agent);
    let reply = parse_reply(action.unwrap());

    assert_eq!(sent["payload"]["session_name"], "s1");
    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(reply["payload"]["context"]["status"], "outside");
    assert_eq!(reply["payload"]["context"]["generation"], "gen-1");
    assert_eq!(reply["payload"]["context"]["scope"]["pane_id"], "%1");
}

#[tokio::test]
async fn preflight_relays_the_agent_field_errors() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    let (broker, mut rx) = claim_agent(&h).await;

    let handled = h.handle_message(proto_msg(
        "server.session.sandbox.preflight",
        json!({
            "session_id": "a1:s1",
            "generation": "gen-1",
            "probe_generation": "probe-1",
            "policy": { "enabled": true, "resource": [{ "key": "cpu.max", "value": "1 1000" }] },
            "working_dir": "/workspace",
        }),
    ));
    let agent = async move {
        answer_agent_frame(
            &mut rx,
            &broker,
            "agent.session.sandbox.preflight",
            json!({
                "success": true,
                "result": {
                    "ok": false,
                    "generation": "gen-1",
                    "mechanisms": [],
                    "errors": [{
                        "field": "resource[0].value",
                        "code": "invalid-value",
                        "message": "cpu.max quota must be a decimal integer or `max`",
                    }],
                    "warnings": [],
                    "catalog": {
                        "status": "available",
                        "platform": "linux",
                        "backend": "linux-bwrap",
                        "probe_generation": "probe-1",
                        "source": "agent-host-probe",
                        "resource_fields": [],
                        "syscall_fields": [],
                    },
                }
            }),
        )
        .await
    };
    let (action, sent) = tokio::join!(handled, agent);
    let reply = parse_reply(action.unwrap());

    assert_eq!(sent["payload"]["session_name"], "s1");
    assert_eq!(sent["payload"]["generation"], "gen-1");
    assert_eq!(sent["payload"]["probe_generation"], "probe-1");
    assert_eq!(sent["payload"]["policy"]["resource"][0]["key"], "cpu.max");
    assert_eq!(reply["payload"]["ok"], false);
    assert_eq!(reply["payload"]["errors"][0]["field"], "resource[0].value");
    assert_eq!(reply["payload"]["errors"][0]["code"], "invalid-value");
}

#[tokio::test]
async fn enter_forwards_the_generation_and_client_enter_id_and_relays_the_refusal() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    let (broker, mut rx) = claim_agent(&h).await;

    let handled = h.handle_message(proto_msg(
        "server.session.sandbox.enter",
        json!({
            "session_id": "a1:s1",
            "generation": "gen-1",
            "probe_generation": "probe-1",
            "enter_id": "enter-1",
            "policy": { "enabled": true },
            "working_dir": "",
        }),
    ));
    let agent = async move {
        answer_agent_frame(
            &mut rx,
            &broker,
            "agent.session.sandbox.enter",
            json!({
                "success": true,
                "result": {
                    "success": false,
                    "error_kind": "conflict",
                    "error": "the Sandbox context changed since preflight; re-run it",
                }
            }),
        )
        .await
    };
    let (action, sent) = tokio::join!(handled, agent);
    let reply = parse_reply(action.unwrap());

    assert_eq!(sent["payload"]["session_name"], "s1");
    assert_eq!(sent["payload"]["generation"], "gen-1");
    assert_eq!(sent["payload"]["probe_generation"], "probe-1");
    assert_eq!(sent["payload"]["enter_id"], "enter-1");
    assert_ne!(
        sent["payload"]["request_id"], sent["payload"]["enter_id"],
        "correlation and client idempotency are different identities"
    );
    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(reply["payload"]["error_kind"], "conflict");
}

#[tokio::test]
async fn an_agent_transport_failure_is_a_typed_unavailable_result() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    // No channel is claimed: the broker cannot deliver, and the handler must
    // answer a typed refusal rather than hanging or claiming success.
    let reply = parse_reply(
        h.handle_message(proto_msg(
            "server.session.sandbox.enter",
            json!({
                "session_id": "a1:s1",
                "generation": "gen-1",
                "enter_id": "enter-1",
                "policy": { "enabled": true },
            }),
        ))
        .await
        .unwrap(),
    );
    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(reply["payload"]["error_kind"], "unavailable");
}

async fn insert_ready_image(h: &ConnectionHandler, image_id: &str, digest: &str) {
    h.db.insert_image(&crate::db::ImageRow {
        image_id: image_id.to_string(),
        digest: Some(digest.to_string()),
        size_bytes: 1,
        source_json: serde_json::json!({
            "kind": "local_directory",
            "path": "/tmp/nession-test-image",
        })
        .to_string(),
        source_sha: None,
        packaging_json: serde_json::to_string(
            &nession_protocol::contracts::image::v1::ImagePackaging::default(),
        )
        .unwrap(),
        status: "ready".to_string(),
        error: None,
        created_at: 1,
        updated_at: 1,
    })
    .await
    .unwrap();
}

fn base_digest() -> String {
    format!("sha256:{}", "a".repeat(64))
}

fn tool_digest() -> String {
    format!("sha256:{}", "b".repeat(64))
}

#[tokio::test]
async fn preflight_forwards_image_selection_metadata_and_refuses_a_missing_base() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    insert_ready_image(&h, "image-base", &base_digest()).await;
    let (broker, mut rx) = claim_agent(&h).await;

    let handled = h.handle_message(proto_msg(
        "server.session.sandbox.preflight",
        json!({
            "session_id": "a1:s1",
            "generation": "gen-1",
            "probe_generation": "probe-1",
            "policy": { "enabled": true },
            "images": [{
                "role": "base",
                "digest": base_digest(),
                "mode": "read_only",
            }],
            "working_dir": "/workspace",
        }),
    ));
    let agent = async move {
        answer_agent_frame(
            &mut rx,
            &broker,
            "agent.session.sandbox.preflight",
            json!({
                "success": true,
                "result": {
                    "ok": true,
                    "generation": "gen-1",
                    "mechanisms": ["filesystem.erofs"],
                    "errors": [],
                    "warnings": [],
                    "catalog": {
                        "status": "available",
                        "platform": "linux",
                        "backend": "linux-bwrap",
                        "probe_generation": "probe-1",
                        "source": "agent-host-probe",
                        "resource_fields": [],
                        "syscall_fields": [],
                    },
                }
            }),
        )
        .await
    };
    let (action, sent) = tokio::join!(handled, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(sent["payload"]["images"][0]["role"], "base");
    assert!(sent["payload"]["images"][0].get("token").is_none());
    assert_eq!(reply["payload"]["ok"], true);

    let refusal = parse_reply(
        h.handle_message(proto_msg(
            "server.session.sandbox.preflight",
            json!({
                "session_id": "a1:s1",
                "generation": "gen-1",
                "policy": { "enabled": true },
                "images": [{
                    "role": "toolchain",
                    "digest": tool_digest(),
                    "target": "/opt/tool",
                    "mode": "read_only",
                }],
            }),
        ))
        .await
        .unwrap(),
    );
    assert_eq!(refusal["payload"]["ok"], false);
    assert_eq!(refusal["payload"]["errors"][0]["field"], "images.base");
}

#[tokio::test]
async fn enter_authorizes_each_image_and_forwards_scoped_grants() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    insert_ready_image(&h, "image-base", &base_digest()).await;
    insert_ready_image(&h, "image-tool", &tool_digest()).await;
    let (broker, mut rx) = claim_agent(&h).await;

    let handled = h.handle_message(proto_msg(
        "server.session.sandbox.enter",
        json!({
            "session_id": "a1:s1",
            "generation": "gen-1",
            "probe_generation": "probe-1",
            "enter_id": "enter-images",
            "policy": { "enabled": true },
            "images": [
                { "role": "base", "digest": base_digest(), "mode": "read_only" },
                { "role": "toolchain", "digest": tool_digest(), "target": "/opt/tool", "mode": "read_only" }
            ],
        }),
    ));
    let agent = async move {
        answer_agent_frame(
            &mut rx,
            &broker,
            "agent.session.sandbox.enter",
            json!({
                "success": true,
                "result": {
                    "success": false,
                    "error_kind": "conflict",
                    "error": "test refusal after authorization",
                }
            }),
        )
        .await
    };
    let (action, sent) = tokio::join!(handled, agent);
    let reply = parse_reply(action.unwrap());
    let images = sent["payload"]["images"].as_array().unwrap();
    assert_eq!(images.len(), 2);
    assert_eq!(images[0]["role"], "base");
    assert_eq!(images[1]["role"], "toolchain");
    assert_eq!(images[1]["target"], "/opt/tool");
    assert!(images[0]["token"].as_str().unwrap().len() == 64);
    assert_eq!(
        images[1]["path"],
        format!("/images/blobs/{}", tool_digest())
    );
    assert_eq!(reply["payload"]["error_kind"], "conflict");
}

#[tokio::test]
async fn context_relays_per_digest_cache_statuses() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    let (broker, mut rx) = claim_agent(&h).await;

    let handled = h.handle_message(proto_msg(
        "server.session.sandbox.context",
        json!({ "session_id": "a1:s1", "cache_digests": [base_digest()] }),
    ));
    let agent = async move {
        answer_agent_frame(
            &mut rx,
            &broker,
            "agent.session.sandbox.context",
            json!({
                "success": true,
                "context": context_payload(),
                "cache_statuses": [{
                    "digest": base_digest(),
                    "state": "verified",
                }],
            }),
        )
        .await
    };
    let (action, sent) = tokio::join!(handled, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(sent["payload"]["cache_digests"][0], base_digest());
    assert_eq!(reply["payload"]["cache_statuses"][0]["state"], "verified");
}

#[tokio::test]
async fn preflight_derives_image_selections_from_the_filesystem_declaration() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    insert_ready_image(&h, "image-base", &base_digest()).await;
    insert_ready_image(&h, "image-tool", &tool_digest()).await;
    let (broker, mut rx) = claim_agent(&h).await;

    let handled = h.handle_message(proto_msg(
        "server.session.sandbox.preflight",
        json!({
            "session_id": "a1:s1",
            "generation": "gen-1",
            "probe_generation": "probe-1",
            "policy": {
                "enabled": true,
                "filesystem": {
                    "access": { "read": [], "write": [] },
                    "rootfs": { "kind": "image", "digest": base_digest() },
                    "mounts": [{
                        "source": { "kind": "image", "digest": tool_digest() },
                        "target": "/opt/tool",
                        "read_only": true,
                    }],
                    "workspace": { "kind": "auto" },
                },
            },
            "images": [],
            "working_dir": "/workspace",
        }),
    ));
    let agent = async move {
        answer_agent_frame(
            &mut rx,
            &broker,
            "agent.session.sandbox.preflight",
            json!({
                "success": true,
                "result": {
                    "ok": true,
                    "generation": "gen-1",
                    "mechanisms": ["filesystem.erofs"],
                    "errors": [],
                    "warnings": [],
                    "catalog": {
                        "status": "available",
                        "platform": "linux",
                        "backend": "linux-bwrap",
                        "probe_generation": "probe-1",
                        "source": "agent-host-probe",
                        "resource_fields": [],
                        "syscall_fields": [],
                    },
                }
            }),
        )
        .await
    };
    let (action, sent) = tokio::join!(handled, agent);
    let reply = parse_reply(action.unwrap());
    let images = sent["payload"]["images"].as_array().unwrap();
    assert_eq!(images.len(), 2);
    assert_eq!(images[0]["role"], "base");
    assert_eq!(images[0]["digest"], base_digest());
    assert_eq!(images[1]["role"], "toolchain");
    assert_eq!(images[1]["target"], "/opt/tool");
    assert_eq!(reply["payload"]["ok"], true);
}

#[tokio::test]
async fn preflight_refuses_local_root_with_mounts_before_routing() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    let reply = parse_reply(
        h.handle_message(proto_msg(
            "server.session.sandbox.preflight",
            json!({
                "session_id": "a1:s1",
                "generation": "gen-1",
                "policy": {
                    "enabled": true,
                    "filesystem": {
                        "access": { "read": [], "write": [] },
                        "rootfs": { "kind": "local" },
                        "mounts": [{
                            "source": { "kind": "image", "digest": tool_digest() },
                            "target": "/opt/tool",
                            "read_only": true,
                        }],
                    },
                },
                "images": [],
            }),
        ))
        .await
        .unwrap(),
    );
    assert_eq!(reply["payload"]["ok"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap_or_default()
        .contains("Local cannot carry"));
}
