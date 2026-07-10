use nession_server::db::Database;
use nession_server::env::EnvService;
use nession_server::registry::{AgentRegistry, SessionRegistry};
use nession_server::server::command_broker::CommandBroker;
use nession_server::server::{ConnectionHandler, HandlerAction};
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message;

async fn make_handler() -> ConnectionHandler {
    let db = Arc::new(Database::new(":memory:").await.unwrap());
    let agent_registry = Arc::new(AgentRegistry::new(30, Arc::clone(&db))); // 30 second heartbeat timeout
    let session_registry = Arc::new(SessionRegistry::new(db));
    let command_broker = Arc::new(CommandBroker::new());
    let env_service = EnvService::new(std::env::temp_dir().join("nession-test-envs"));
    ConnectionHandler::new(
        agent_registry,
        session_registry,
        command_broker,
        env_service,
        "test_token".to_string(),
        30,
    )
}

fn make_text_message(msg_type: &str, payload: serde_json::Value) -> Message {
    let msg = serde_json::json!({
        "msg_type": msg_type,
        "id": "test-123",
        "timestamp": 1234567890,
        "payload": payload
    });
    Message::Text(msg.to_string())
}

#[tokio::test]
async fn test_agent_command_response_without_registration() {
    let mut handler = make_handler().await;

    // Send command response without registering first
    let msg = make_text_message(
        "agent.session.command.response",
        serde_json::json!({
            "request_id": "req-123",
            "command": "session.create",
            "success": true
        }),
    );

    let result = handler.handle_message(msg).await.unwrap();
    match result {
        HandlerAction::Reply(None) => {} // Expected - no response sent
        _ => panic!("Expected HandlerAction::Reply(None)"),
    }
}

#[tokio::test]
async fn test_agent_command_response_missing_request_id() {
    let mut handler = make_handler().await;

    // First register as an agent
    let register_msg = make_text_message(
        "agent.register",
        serde_json::json!({
            "agent_id": "test-agent",
            "hostname": "test-host",
            "ip_address": "127.0.0.1",
            "port": 8080,
            "auth_token": "test_token",
            "protocol_version": "1.0",
            "metadata": {
                "tmux_version": "3.3a",
                "os_version": "linux",
                "nession_version": "0.1.0"
            }
        }),
    );
    let _ = handler.handle_message(register_msg).await.unwrap();

    // Send command response without request_id
    let msg = make_text_message(
        "agent.session.command.response",
        serde_json::json!({
            "command": "session.create",
            "success": true
        }),
    );

    let result = handler.handle_message(msg).await.unwrap();
    match result {
        HandlerAction::Reply(None) => {} // Expected - no response sent
        _ => panic!("Expected HandlerAction::Reply(None)"),
    }
}

#[tokio::test]
async fn test_agent_command_response_with_valid_request() {
    let mut handler = make_handler().await;

    // First register as an agent
    let register_msg = make_text_message(
        "agent.register",
        serde_json::json!({
            "agent_id": "test-agent",
            "hostname": "test-host",
            "ip_address": "127.0.0.1",
            "port": 8080,
            "auth_token": "test_token",
            "protocol_version": "1.0",
            "metadata": {
                "tmux_version": "3.3a",
                "os_version": "linux",
                "nession_version": "0.1.0"
            }
        }),
    );
    let _ = handler.handle_message(register_msg).await.unwrap();

    // Send valid command response
    let msg = make_text_message(
        "agent.session.command.response",
        serde_json::json!({
            "request_id": "req-123",
            "command": "session.create",
            "success": true,
            "session_id": "test-agent:session1"
        }),
    );

    let result = handler.handle_message(msg).await.unwrap();
    match result {
        HandlerAction::Reply(None) => {} // Expected - no response sent
        _ => panic!("Expected HandlerAction::Reply(None)"),
    }
}

#[tokio::test]
async fn test_unknown_message_type() {
    let mut handler = make_handler().await;

    let msg = make_text_message("unknown.message.type", serde_json::json!({}));

    let result = handler.handle_message(msg).await.unwrap();
    match result {
        HandlerAction::Reply(None) => {} // Expected - unknown types are ignored
        _ => panic!("Expected HandlerAction::Reply(None)"),
    }
}

#[tokio::test]
async fn test_agent_session_update_unknown_status() {
    let mut handler = make_handler().await;

    // First register as an agent
    let register_msg = make_text_message(
        "agent.register",
        serde_json::json!({
            "agent_id": "test-agent",
            "hostname": "test-host",
            "ip_address": "127.0.0.1",
            "port": 8080,
            "auth_token": "test_token",
            "protocol_version": "1.0",
            "metadata": {
                "tmux_version": "3.3a",
                "os_version": "linux",
                "nession_version": "0.1.0"
            }
        }),
    );
    let _ = handler.handle_message(register_msg).await.unwrap();

    // Send session update with unknown status
    let msg = make_text_message(
        "agent.session.update",
        serde_json::json!({
            "agent_id": "test-agent",
            "session_name": "session1",
            "status": "invalid_status",
            "window_count": 1,
            "attached_clients": 0
        }),
    );

    let result = handler.handle_message(msg).await.unwrap();
    match result {
        HandlerAction::Reply(None) => {} // Expected - session ignored but no error
        _ => panic!("Expected HandlerAction::Reply(None)"),
    }
}

#[tokio::test]
async fn test_client_session_attach_agent_offline() {
    let mut handler = make_handler().await;

    // Authenticate as client
    let auth_msg = make_text_message(
        "client.auth",
        serde_json::json!({
            "auth_token": "test_token"
        }),
    );
    let _ = handler.handle_message(auth_msg).await.unwrap();

    // Try to attach to a session on an offline agent
    let msg = make_text_message(
        "client.session.attach",
        serde_json::json!({
            "session_id": "offline-agent:session1",
            "mode": "p2p"
        }),
    );

    let result = handler.handle_message(msg).await.unwrap();
    match result {
        HandlerAction::Reply(Some(reply)) => {
            let reply_str = reply.to_string();
            assert!(reply_str.contains("not found") || reply_str.contains("offline"));
        }
        _ => panic!("Expected error response"),
    }
}

#[tokio::test]
async fn test_client_session_create_agent_offline() {
    let mut handler = make_handler().await;

    // Authenticate as client
    let auth_msg = make_text_message(
        "client.auth",
        serde_json::json!({
            "auth_token": "test_token"
        }),
    );
    let _ = handler.handle_message(auth_msg).await.unwrap();

    // Try to create a session on an offline agent
    let msg = make_text_message(
        "client.session.create",
        serde_json::json!({
            "agent_id": "offline-agent",
            "name": "new-session"
        }),
    );

    let result = handler.handle_message(msg).await.unwrap();
    match result {
        HandlerAction::Reply(Some(reply)) => {
            let reply_str = reply.to_string();
            assert!(reply_str.contains("not found") || reply_str.contains("offline"));
        }
        _ => panic!("Expected error response"),
    }
}

#[tokio::test]
async fn test_client_session_kill_agent_offline() {
    let mut handler = make_handler().await;

    // Authenticate as client
    let auth_msg = make_text_message(
        "client.auth",
        serde_json::json!({
            "auth_token": "test_token"
        }),
    );
    let _ = handler.handle_message(auth_msg).await.unwrap();

    // Try to kill a session on an offline agent
    let msg = make_text_message(
        "client.session.kill",
        serde_json::json!({
            "session_id": "offline-agent:session1"
        }),
    );

    let result = handler.handle_message(msg).await.unwrap();
    match result {
        HandlerAction::Reply(Some(reply)) => {
            let reply_str = reply.to_string();
            assert!(reply_str.contains("not found") || reply_str.contains("offline"));
        }
        _ => panic!("Expected error response"),
    }
}
