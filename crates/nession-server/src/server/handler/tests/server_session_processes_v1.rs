//! Tests localized to the server_session_processes_v1 handler (#2514).
use super::*;

fn snapshot_json() -> serde_json::Value {
    json!({
        "session_name": "s1",
        "snapshot_at_ms": 1_700_000_000_000_i64,
        "platform": "linux",
        "methods": ["process_tree"],
        "panes": [{
            "session_ids": ["$0"],
            "session_names": ["s1"],
            "window_id": "@0",
            "window_index": 0,
            "window_name": "shell",
            "pane_id": "%0",
            "pane_index": 0,
            "pane_pid": 10,
            "pane_tty": "/dev/pts/1",
            "method": "process_tree",
            "coverage": "partial",
            "reason_codes": ["no_dedicated_cgroup"],
            "processes": [{
                "pid": 10,
                "parent_pid": 1,
                "start_time_ms": 1_699_999_000_000_i64,
                "command": "bash -l",
                "command_state": "sampled",
                "executable": "bash",
                "redacted": false,
                "truncated": false,
                "cpu_percent": { "value": 0.0, "state": "sampled" },
                "rss_mib": { "value": 12.0, "state": "sampled" },
                "threads": { "value": 2.0, "state": "sampled" },
                "elapsed_ms": { "value": 1000.0, "state": "sampled" },
                "io_read_kib_per_s": { "state": "unsupported", "reason": "no_io_counters" },
                "io_write_kib_per_s": { "state": "unsupported", "reason": "no_io_counters" }
            }]
        }],
        "truncated": false,
        "limits": { "max_processes": 512, "max_depth": 32, "cpu_window_ms": 150 }
    })
}

#[tokio::test]
async fn an_unauthenticated_client_is_refused() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.session.processes",
            json!({ "session_id": "a1:s1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "error");
    assert_eq!(reply["payload"]["message"], "Not authenticated");
}

#[tokio::test]
async fn a_malformed_session_id_is_refused() {
    let mut h = handler_with_online_agent().await;
    let action = h
        .handle_message(proto_msg(
            "server.session.processes",
            json!({ "session_id": "not-a-joined-id" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "error");
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("Expected 'agent_id:session_name'"));
}

#[tokio::test]
async fn an_unknown_agent_is_refused_without_asking_anyone() {
    let mut h = handler_with_online_agent().await;
    let action = h
        .handle_message(proto_msg(
            "server.session.processes",
            json!({ "session_id": "missing:s1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "error");
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

#[tokio::test]
async fn a_snapshot_from_the_agent_is_relayed_to_the_browser() {
    let mut h = handler_with_online_agent().await;
    let (sender, mut rx) = crate::server::outbound::WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let request = h.handle_message(proto_msg(
        "server.session.processes",
        json!({ "session_id": "a1:s1" }),
    ));
    let agent = async move {
        let text = rx
            .recv()
            .await
            .expect("agent receives the process request")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["msg_type"], "agent.session.processes");
        // The Server forwards only the Session name; it does not enumerate.
        assert_eq!(parsed["payload"]["session_name"], "s1");
        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        broker
            .resolve_command(
                "a1",
                &request_id,
                json!({ "success": true, "snapshot": snapshot_json() }),
            )
            .await;
    };

    let (action, ()) = tokio::join!(request, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(reply["payload"]["snapshot"]["session_name"], "s1");
    assert_eq!(reply["payload"]["snapshot"]["panes"][0]["pane_id"], "%0");
    assert_eq!(
        reply["payload"]["snapshot"]["panes"][0]["processes"][0]["pid"],
        10
    );
}

#[tokio::test]
async fn an_agent_refusal_keeps_the_agents_own_reason() {
    let mut h = handler_with_online_agent().await;
    let (sender, mut rx) = crate::server::outbound::WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let request = h.handle_message(proto_msg(
        "server.session.processes",
        json!({ "session_id": "a1:gone" }),
    ));
    let agent = async move {
        let text = rx
            .recv()
            .await
            .expect("agent receives the process request")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        broker
            .resolve_command(
                "a1",
                &request_id,
                json!({ "success": false, "error": "session not found: gone" }),
            )
            .await;
    };

    let (action, ()) = tokio::join!(request, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(reply["payload"]["status"], "error");
    assert_eq!(reply["payload"]["message"], "session not found: gone");
}

#[tokio::test]
async fn an_unreadable_snapshot_is_a_refusal_not_a_partial_answer() {
    let mut h = handler_with_online_agent().await;
    let (sender, mut rx) = crate::server::outbound::WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let request = h.handle_message(proto_msg(
        "server.session.processes",
        json!({ "session_id": "a1:s1" }),
    ));
    let agent = async move {
        let text = rx
            .recv()
            .await
            .expect("agent receives the process request")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        broker
            .resolve_command(
                "a1",
                &request_id,
                json!({ "success": true, "snapshot": { "not": "a snapshot" } }),
            )
            .await;
    };

    let (action, ()) = tokio::join!(request, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(reply["payload"]["status"], "error");
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("unreadable process snapshot"));
}
