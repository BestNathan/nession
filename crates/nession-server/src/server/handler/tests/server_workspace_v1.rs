//! Tests for the Agent-owned managed Workspace units (#3407).

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

fn descriptor() -> serde_json::Value {
    json!({
        "workspace_id": "ws_123e4567-e89b-42d3-a456-426614174000",
        "name": "fix-terminal",
        "namespace": "default",
        "kind": "managed",
        "status": "available",
        "auto_created": true,
        "created_at": 1,
        "last_used_at": 2,
    })
}

#[tokio::test]
async fn workspace_units_refuse_an_unauthenticated_client() {
    let mut h = test_handler("").await;
    let list = parse_reply(
        h.handle_message(proto_msg(
            "server.workspace.list",
            json!({ "session_id": "a1:s1" }),
        ))
        .await
        .unwrap(),
    );
    assert_eq!(list["payload"]["success"], false);
    assert_eq!(list["payload"]["error"], "Not authenticated");

    let create = parse_reply(
        h.handle_message(proto_msg(
            "server.workspace.create",
            json!({ "session_id": "a1:s1", "name": "fix-terminal" }),
        ))
        .await
        .unwrap(),
    );
    assert_eq!(create["payload"]["success"], false);
    assert_eq!(create["payload"]["error"], "Not authenticated");

    let delete = parse_reply(
        h.handle_message(proto_msg(
            "server.workspace.delete",
            json!({
                "session_id": "a1:s1",
                "workspace_id": "ws_123e4567-e89b-42d3-a456-426614174000",
            }),
        ))
        .await
        .unwrap(),
    );
    assert_eq!(delete["payload"]["success"], false);
    assert_eq!(delete["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn workspace_list_relays_the_agent_inventory() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    let (broker, mut rx) = claim_agent(&h).await;

    let handled = h.handle_message(proto_msg(
        "server.workspace.list",
        json!({ "session_id": "a1:s1", "namespace": "project:project-1" }),
    ));
    let agent = async move {
        answer_agent_frame(
            &mut rx,
            &broker,
            "agent.workspace.list",
            json!({
                "success": true,
                "workspaces": [descriptor()],
            }),
        )
        .await
    };
    let (action, sent) = tokio::join!(handled, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(sent["payload"]["namespace"], "project:project-1");
    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(
        reply["payload"]["workspaces"][0]["workspace_id"],
        "ws_123e4567-e89b-42d3-a456-426614174000"
    );
    assert_eq!(reply["payload"]["workspaces"][0]["status"], "available");
}

#[tokio::test]
async fn workspace_list_refuses_an_invalid_descriptor() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    let (broker, mut rx) = claim_agent(&h).await;
    let mut leaked = descriptor();
    leaked["path"] = json!("/var/lib/nession/workspaces/secret");

    let handled = h.handle_message(proto_msg(
        "server.workspace.list",
        json!({ "session_id": "a1:s1" }),
    ));
    let agent = async move {
        answer_agent_frame(
            &mut rx,
            &broker,
            "agent.workspace.list",
            json!({ "success": true, "workspaces": [leaked] }),
        )
        .await
    };
    let (action, _sent) = tokio::join!(handled, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(
        reply["payload"]["error"],
        "Agent returned an invalid Workspace descriptor"
    );
}

#[tokio::test]
async fn workspace_create_relays_get_or_create() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    let (broker, mut rx) = claim_agent(&h).await;

    let handled = h.handle_message(proto_msg(
        "server.workspace.create",
        json!({ "session_id": "a1:s1", "name": "fix-terminal", "auto_created": true }),
    ));
    let agent = async move {
        answer_agent_frame(
            &mut rx,
            &broker,
            "agent.workspace.create",
            json!({ "success": true, "workspace": descriptor() }),
        )
        .await
    };
    let (action, sent) = tokio::join!(handled, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(sent["payload"]["name"], "fix-terminal");
    assert_eq!(sent["payload"]["auto_created"], true);
    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(reply["payload"]["workspace"]["name"], "fix-terminal");
}

#[tokio::test]
async fn workspace_delete_refuses_an_invalid_id_before_routing() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    let reply = parse_reply(
        h.handle_message(proto_msg(
            "server.workspace.delete",
            json!({ "session_id": "a1:s1", "workspace_id": "ws_not-a-uuid" }),
        ))
        .await
        .unwrap(),
    );
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap_or_default()
        .contains("valid managed Workspace identity"));
}

#[tokio::test]
async fn workspace_delete_relays_the_agent_refusal() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    let (broker, mut rx) = claim_agent(&h).await;

    let handled = h.handle_message(proto_msg(
        "server.workspace.delete",
        json!({
            "session_id": "a1:s1",
            "workspace_id": "ws_123e4567-e89b-42d3-a456-426614174000",
        }),
    ));
    let agent = async move {
        answer_agent_frame(
            &mut rx,
            &broker,
            "agent.workspace.delete",
            json!({ "success": false, "error": "workspace is in use" }),
        )
        .await
    };
    let (action, sent) = tokio::join!(handled, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(
        sent["payload"]["workspace_id"],
        "ws_123e4567-e89b-42d3-a456-426614174000"
    );
    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(reply["payload"]["error"], "workspace is in use");
}

#[tokio::test]
async fn workspace_list_refuses_an_invalid_namespace() {
    let mut h = handler_with_online_agent().await;
    register_session(&h, "a1:s1").await;
    let reply = parse_reply(
        h.handle_message(proto_msg(
            "server.workspace.list",
            json!({ "session_id": "a1:s1", "namespace": "bad namespace" }),
        ))
        .await
        .unwrap(),
    );
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap_or_default()
        .contains("forbidden character"));
}
