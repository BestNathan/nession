use super::v1::*;

#[test]
fn a_process_snapshot_round_trips_with_its_honest_unknowns() {
    // #2514: the wire must be able to say "not sampled" without a number, and
    // must keep a sampled zero looking like an observation rather than an
    // absence. Both are asserted in one round trip because that is the shape a
    // consumer actually has to render.
    let snapshot = ProcessSnapshot {
        session_name: "work".to_string(),
        snapshot_at_ms: 1_700_000_000_000,
        platform: "linux".to_string(),
        methods: vec![
            ProcessDiscoveryMethod::Cgroup,
            ProcessDiscoveryMethod::ProcessTree,
        ],
        panes: vec![PaneProcessSnapshot {
            session_ids: vec!["$0".to_string(), "$1".to_string()],
            session_names: vec!["work".to_string(), "linked".to_string()],
            window_id: "@1".to_string(),
            window_index: 1,
            window_name: "editor".to_string(),
            pane_id: "%3".to_string(),
            pane_index: 0,
            pane_pid: Some(4242),
            pane_tty: Some("/dev/pts/3".to_string()),
            method: ProcessDiscoveryMethod::Cgroup,
            coverage: ProcessCoverage::Complete,
            reason_codes: vec!["shared_window".to_string()],
            processes: vec![DiscoveredProcess {
                pid: 4242,
                parent_pid: Some(1),
                start_time_ms: Some(1_699_999_000_000),
                tty: Some("/dev/pts/3".to_string()),
                sid: Some(4242),
                pgid: Some(4242),
                executable: "bash".to_string(),
                command: "bash -l --token [REDACTED]".to_string(),
                command_state: ProcessMetricState::Sampled,
                command_reason: None,
                redacted: true,
                truncated: false,
                cpu_percent: ProcessMetric::sampled(0.0),
                rss_mib: ProcessMetric::sampled(12.5),
                threads: ProcessMetric::unavailable(
                    ProcessMetricState::Denied,
                    "proc_status_denied",
                ),
                elapsed_ms: ProcessMetric::sampled(60_000.0),
                io_read_kib_per_s: ProcessMetric::unavailable(
                    ProcessMetricState::Unsupported,
                    "no_io_counters",
                ),
                io_write_kib_per_s: ProcessMetric::unavailable(
                    ProcessMetricState::Unsupported,
                    "no_io_counters",
                ),
            }],
        }],
        truncated: false,
        limits: ProcessDiscoveryLimits {
            max_processes: 512,
            max_depth: 32,
            cpu_window_ms: 150,
        },
    };

    let encoded = serde_json::to_value(&snapshot).unwrap();
    let decoded: ProcessSnapshot = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(decoded, snapshot);

    // A sampled zero keeps its value; an unsupported metric carries no value.
    assert_eq!(
        encoded["panes"][0]["processes"][0]["cpu_percent"]["value"],
        0.0
    );
    assert_eq!(
        encoded["panes"][0]["processes"][0]["cpu_percent"]["state"],
        "sampled"
    );
    assert!(encoded["panes"][0]["processes"][0]["threads"]
        .get("value")
        .is_none());
    assert_eq!(
        encoded["panes"][0]["processes"][0]["threads"]["state"],
        "denied"
    );
}

#[test]
fn a_process_refusal_is_not_a_snapshot() {
    // The untagged reply is only safe while the two shapes are disjoint. This
    // pins the discriminant: a refusal decodes to Refused, and a snapshot
    // decodes to Snapshot, with no field overlap required.
    let refusal: ServerSessionProcessesReply = serde_json::from_value(serde_json::json!({
        "status": "error",
        "message": "Not authenticated"
    }))
    .unwrap();
    assert!(matches!(refusal, ServerSessionProcessesReply::Refused(_)));

    let reply: ServerSessionProcessesReply = serde_json::from_value(serde_json::json!({
        "snapshot": {
            "session_name": "s",
            "snapshot_at_ms": 1,
            "platform": "macos",
            "methods": [],
            "panes": [],
            "truncated": false,
            "limits": { "max_processes": 1, "max_depth": 1, "cpu_window_ms": 1 }
        }
    }))
    .unwrap();
    assert!(matches!(reply, ServerSessionProcessesReply::Snapshot(_)));
}

#[test]
fn test_default_attach_mode() {
    assert_eq!(default_attach_mode(), "p2p");
}

#[test]
fn test_terminal_resize_payload_serde() {
    let payload = AgentTerminalResizePayload {
        session_id: "session-123".to_string(),
        cols: 120,
        rows: 40,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let deserialized: AgentTerminalResizePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.session_id, "session-123");
    assert_eq!(deserialized.cols, 120);
    assert_eq!(deserialized.rows, 40);
}

#[test]
fn test_server_terminal_resize_payload_serde() {
    let payload = ServerTerminalResizePayload {
        session_id: "session-123".to_string(),
        cols: 120,
        rows: 40,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let deserialized: ServerTerminalResizePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.session_id, "session-123");
    assert_eq!(deserialized.cols, 120);
    assert_eq!(deserialized.rows, 40);
}

#[test]
fn test_client_session_attach_payload_default_env_snapshots() {
    let json = serde_json::json!({
        "session_id": "agent:session",
        "preferred_mode": "relay"
    });
    let payload: ClientSessionAttachPayload = serde_json::from_value(json).unwrap();
    assert_eq!(payload.session_id, "agent:session");
    assert_eq!(payload.preferred_mode, "relay");
    assert!(payload.env_snapshots.is_empty());
}

#[test]
fn test_client_session_attach_payload_with_env_snapshots() {
    let json = serde_json::json!({
        "session_id": "agent:session",
        "preferred_mode": "relay",
        "env_snapshots": [{
            "name": "staging.env",
            "source": "server",
            "vars": [["NODE_ENV", "staging"], ["DEBUG", "true"]],
            "warnings": []
        }]
    });
    let payload: ClientSessionAttachPayload = serde_json::from_value(json).unwrap();
    assert_eq!(payload.env_snapshots.len(), 1);
    assert_eq!(payload.env_snapshots[0].name, "staging.env");
    assert_eq!(payload.env_snapshots[0].vars.len(), 2);
}

#[test]
fn test_server_session_create_payload() {
    let payload = ServerSessionCreatePayload {
        request_id: "req-1".to_string(),
        name: "my-session".to_string(),
        width: 120,
        height: 40,
        working_dir: None,
        env_snapshots: Vec::new(),
        terminal_cols: None,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ServerSessionCreatePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.request_id, "req-1");
    assert_eq!(decoded.name, "my-session");
    assert_eq!(decoded.width, 120);
    assert_eq!(decoded.height, 40);
}

#[test]
fn test_server_session_create_default_dimensions() {
    let json = r#"{"request_id":"req-1","name":"sess"}"#;
    let decoded: ServerSessionCreatePayload = serde_json::from_str(json).unwrap();
    assert_eq!(decoded.width, 80);
    assert_eq!(decoded.height, 24);
}

#[test]
fn test_server_session_kill_payload() {
    let payload = ServerSessionKillPayload {
        request_id: "req-2".to_string(),
        name: "doomed".to_string(),
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ServerSessionKillPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.request_id, "req-2");
    assert_eq!(decoded.name, "doomed");
}

#[test]
fn test_agent_command_response_payload() {
    let payload = AgentCommandResponsePayload {
        request_id: "req-1".to_string(),
        command: "session.create".to_string(),
        success: true,
        error: None,
        session_name: Some("new-session".to_string()),
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: AgentCommandResponsePayload = serde_json::from_str(&json).unwrap();
    assert!(decoded.success);
    assert_eq!(decoded.session_name, Some("new-session".to_string()));
}

#[test]
fn test_agent_command_response_payload_failure() {
    let payload = AgentCommandResponsePayload {
        request_id: "req-2".to_string(),
        command: "session.create".to_string(),
        success: false,
        error: Some("session already exists".to_string()),
        session_name: None,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: AgentCommandResponsePayload = serde_json::from_str(&json).unwrap();
    assert!(!decoded.success);
    assert_eq!(decoded.error, Some("session already exists".to_string()));
    assert!(decoded.session_name.is_none());
}

#[test]
fn test_client_session_create_payload() {
    let payload = ClientSessionCreatePayload {
        agent_id: "agent-1".to_string(),
        name: "new-session".to_string(),
        working_dir: None,
        env_files: Vec::new(),
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ClientSessionCreatePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.agent_id, "agent-1");
    assert_eq!(decoded.name, "new-session");
    assert!(decoded.env_files.is_empty());
}

#[test]
fn test_client_session_create_env_files_are_part_of_the_contract() {
    // `env_files` was read off the payload by the handler for as long as
    // create-time injection has existed, and was not declared until reading it
    // stopped compiling — the parse moved the payload and the second read was
    // left dangling. Pinned here so the contract keeps naming it.
    let json = serde_json::json!({
        "agent_id": "agent-1",
        "name": "new-session",
        "env_files": [{ "name": "staging.env", "source": "server" }],
    });
    let decoded: ClientSessionCreatePayload = serde_json::from_value(json).unwrap();
    assert_eq!(decoded.env_files.len(), 1);
    assert_eq!(decoded.env_files.first().unwrap().name, "staging.env");
}

#[test]
fn test_client_session_kill_payload() {
    let payload = ClientSessionKillPayload {
        session_id: "agent-1:doomed".to_string(),
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ClientSessionKillPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.session_id, "agent-1:doomed");
}

#[test]
fn test_client_session_create_response_payload() {
    let payload = ClientSessionCreateResponsePayload {
        success: true,
        session_id: Some("agent-1:new-sess".to_string()),
        error: None,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ClientSessionCreateResponsePayload = serde_json::from_str(&json).unwrap();
    assert!(decoded.success);
    assert_eq!(decoded.session_id, Some("agent-1:new-sess".to_string()));
}

#[test]
fn test_client_session_kill_response_payload() {
    let payload = ClientSessionKillResponsePayload {
        success: true,
        error: None,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ClientSessionKillResponsePayload = serde_json::from_str(&json).unwrap();
    assert!(decoded.success);
}
