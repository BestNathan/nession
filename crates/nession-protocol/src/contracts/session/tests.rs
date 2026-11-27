use super::v1::*;
use crate::contracts::sandbox::v1::{
    SandboxActionResult, SandboxFieldError, SandboxPreflightResult,
};

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
fn test_client_session_attach_reply_states_the_agent_token() {
    // #3440: the authenticated attach hands off the resolved Agent's durable
    // token. The relay arm omits it because the Server dials the Agent itself.
    let reply: ClientSessionAttachReply = serde_json::from_value(serde_json::json!({
        "status": "success",
        "mode": "p2p",
        "session_id": "agent:session",
        "agent_token": "agent-token"
    }))
    .unwrap();
    let ClientSessionAttachReply::Attached(payload) = reply else {
        panic!("expected the attached arm");
    };
    assert_eq!(
        payload
            .agent_token
            .as_ref()
            .map(crate::secret::RedactedToken::as_str),
        Some("agent-token")
    );

    let legacy: ClientSessionAttachReply = serde_json::from_value(serde_json::json!({
        "status": "success",
        "mode": "relay",
        "session_id": "agent:session"
    }))
    .unwrap();
    let ClientSessionAttachReply::Attached(legacy) = legacy else {
        panic!("expected the attached arm");
    };
    assert_eq!(legacy.agent_token, None);
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
        binding_profiles: Vec::new(),
        binding_revision: None,
        terminal_cols: None,
        sandbox: None,
        managed: None,
        initial_metadata: None,
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
        expected_instance_id: None,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ServerSessionKillPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.request_id, "req-2");
    assert_eq!(decoded.name, "doomed");
    assert!(
        !json.contains("expected_instance_id"),
        "an absent precondition stays absent on the legacy wire"
    );

    // #4302: a guarded kill carries the caller-observed incarnation.
    let guarded = ServerSessionKillPayload {
        expected_instance_id: Some("instance-a".to_string()),
        ..payload
    };
    let json = serde_json::to_string(&guarded).unwrap();
    let decoded: ServerSessionKillPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.expected_instance_id.as_deref(), Some("instance-a"));
}

#[test]
fn test_agent_command_response_payload() {
    let payload = AgentCommandResponsePayload {
        request_id: "req-1".to_string(),
        command: "session.create".to_string(),
        success: true,
        error: None,
        session_name: Some("new-session".to_string()),
        sandbox: None,
        instance_id: Some("instance-a".to_string()),
        metadata: None,
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
        sandbox: None,
        instance_id: None,
        metadata: None,
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
        env_selection_mode: None,
        sandbox: None,
        project_id: None,
        managed: None,
        initial_metadata: None,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ClientSessionCreatePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.agent_id, "agent-1");
    assert_eq!(decoded.name, "new-session");
    assert!(decoded.env_files.is_empty());
    assert!(decoded.project_id.is_none());
}

#[test]
fn test_client_session_create_project_reference_is_optional_and_round_trips() {
    // #3025: a Project reference is additive. An old client omits it and is
    // unchanged; a Project-aware client names it together with the Existing
    // Location's Agent and directory.
    let json = serde_json::json!({
        "agent_id": "agent-1",
        "name": "new-session",
        "working_dir": "/srv/project",
        "project_id": "project-123e4567-e89b-42d3-a456-426614174000",
    });
    let decoded: ClientSessionCreatePayload = serde_json::from_value(json).unwrap();
    assert_eq!(
        decoded.project_id.as_deref(),
        Some("project-123e4567-e89b-42d3-a456-426614174000")
    );
    assert_eq!(decoded.working_dir.as_deref(), Some("/srv/project"));

    let legacy: ClientSessionCreatePayload =
        serde_json::from_value(serde_json::json!({ "agent_id": "a", "name": "n" })).unwrap();
    assert!(legacy.project_id.is_none());
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
fn test_client_session_create_env_selection_mode_is_optional_and_typed() {
    // #3649: absence preserves the old inherit/explicit precedence. The two
    // supported values are the only wire spellings; an unknown value must fail
    // decoding rather than degrade into a different selection.
    let legacy: ClientSessionCreatePayload =
        serde_json::from_value(serde_json::json!({ "agent_id": "a", "name": "n" })).unwrap();
    assert!(legacy.env_selection_mode.is_none());

    for (wire, expected) in [
        ("inherit", EnvSelectionMode::Inherit),
        ("replace", EnvSelectionMode::Replace),
    ] {
        let decoded: ClientSessionCreatePayload = serde_json::from_value(serde_json::json!({
            "agent_id": "a",
            "name": "n",
            "env_selection_mode": wire,
        }))
        .unwrap();
        assert_eq!(decoded.env_selection_mode, Some(expected));
    }

    let invalid = serde_json::from_value::<ClientSessionCreatePayload>(serde_json::json!({
        "agent_id": "a",
        "name": "n",
        "env_selection_mode": "append",
    }));
    assert!(
        invalid.is_err(),
        "an unsupported env_selection_mode must not decode"
    );
}

#[test]
fn test_client_session_create_response_carries_project_membership() {
    let json = serde_json::json!({
        "success": true,
        "session_id": "a1:s1",
        "warnings": [],
        "project_id": "project-123e4567-e89b-42d3-a456-426614174000",
    });
    let decoded: ClientSessionCreateResponsePayload = serde_json::from_value(json).unwrap();
    assert_eq!(
        decoded.project_id.as_deref(),
        Some("project-123e4567-e89b-42d3-a456-426614174000")
    );
    let legacy: ClientSessionCreateResponsePayload =
        serde_json::from_value(serde_json::json!({ "success": true, "session_id": "a1:s1" }))
            .unwrap();
    assert!(legacy.project_id.is_none());
}

#[test]
fn test_session_project_binding_payload_removes_with_null_and_carries_expected_revision() {
    let json = serde_json::json!({
        "session_id": "a1:s1",
        "project_id": null,
        "expected_revision": 2,
    });
    let decoded: SessionProjectBindingUpdatePayload = serde_json::from_value(json).unwrap();
    assert!(decoded.project_id.is_none());
    assert_eq!(decoded.expected_revision, Some(2));

    let absent: SessionProjectBindingUpdatePayload =
        serde_json::from_value(serde_json::json!({ "session_id": "a1:s1" })).unwrap();
    assert!(absent.project_id.is_none());
    assert!(absent.expected_revision.is_none());
}

#[test]
fn test_session_instance_identity_is_optional_on_updates_and_reports() {
    let update: AgentSessionUpdatePayload = serde_json::from_value(serde_json::json!({
        "agent_id": "a1",
        "session_name": "s1",
        "status": "active",
        "window_count": 1,
        "attached_clients": 0,
        "instance_id": "instance-1",
    }))
    .unwrap();
    assert_eq!(update.instance_id.as_deref(), Some("instance-1"));

    let legacy_update: AgentSessionUpdatePayload = serde_json::from_value(serde_json::json!({
        "agent_id": "a1",
        "session_name": "s1",
        "status": "active",
        "window_count": 1,
        "attached_clients": 0,
    }))
    .unwrap();
    assert!(legacy_update.instance_id.is_none());

    let report: SessionInfo = serde_json::from_value(serde_json::json!({
        "name": "s1",
        "created_at": 1,
        "window_count": 1,
        "attached_clients": 0,
        "width": 80,
        "height": 24,
        "foreground_command": null,
        "instance_id": "instance-1",
    }))
    .unwrap();
    assert_eq!(report.instance_id.as_deref(), Some("instance-1"));
}

#[test]
fn session_activity_is_optional_and_independent_on_the_web_projection() {
    let base = serde_json::json!({
        "session_id": "a1:s1",
        "agent_id": "a1",
        "session_name": "s1",
        "status": "detached",
        "window_count": 1,
        "attached_clients": 0,
        "last_activity": "2026-11-18T00:00:00Z",
    });

    // A legacy Agent reports no activity at all. That is `unknown` to a
    // consumer, and the wire says so by absence rather than inventing idle.
    let legacy: WebSessionInfo = serde_json::from_value(base).unwrap();
    assert!(legacy.activity.is_none());

    let with_activity: WebSessionInfo = serde_json::from_value(serde_json::json!({
        "session_id": "a1:s1",
        "agent_id": "a1",
        "session_name": "s1",
        "status": "detached",
        "window_count": 1,
        "attached_clients": 0,
        "activity": {
            "state": "working",
            "attention": "input_required",
            "capability_id": "claude-code",
            "observed_at_ms": 1_700_000_000_000_i64
        },
        "last_activity": "2026-11-18T00:00:00Z",
    }))
    .unwrap();
    let activity = with_activity.activity.expect("activity is present");
    assert_eq!(activity.state, "working");
    assert_eq!(activity.attention.as_deref(), Some("input_required"));
    assert_eq!(activity.capability_id.as_deref(), Some("claude-code"));

    // The lifecycle `status` and the activity level are different fields with
    // different values; the projection does not merge them.
    assert_eq!(with_activity.status, "detached");
}

#[test]
fn agent_session_activity_payload_round_trips_with_its_identity_fence() {
    let payload = AgentSessionActivityPayload {
        agent_id: "a1".to_string(),
        session_name: "s1".to_string(),
        instance_id: "inc-1".to_string(),
        epoch: "epoch-1".to_string(),
        generation: 7,
        state: "idle".to_string(),
        attention: None,
        capability_id: Some("shell".to_string()),
        observed_at_ms: 1_700_000_000_000,
    };
    let json = serde_json::to_value(&payload).unwrap();
    assert!(
        json.get("attention").is_none(),
        "an absent attention is absent"
    );
    let decoded: AgentSessionActivityPayload = serde_json::from_value(json).unwrap();
    assert_eq!(decoded, payload);
}

#[test]
fn test_client_session_kill_payload() {
    let payload = ClientSessionKillPayload {
        session_id: "agent-1:doomed".to_string(),
        expected_instance_id: None,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ClientSessionKillPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.session_id, "agent-1:doomed");
    assert!(
        !json.contains("expected_instance_id"),
        "an absent precondition stays absent on the legacy wire"
    );

    // #4302: a legacy payload without the field still decodes, and a guarded
    // one round-trips its precondition.
    let legacy: ClientSessionKillPayload =
        serde_json::from_str(r#"{"session_id":"agent-1:doomed"}"#).unwrap();
    assert_eq!(legacy.expected_instance_id, None);
    let guarded = ClientSessionKillPayload {
        expected_instance_id: Some("instance-a".to_string()),
        ..payload
    };
    let json = serde_json::to_string(&guarded).unwrap();
    let decoded: ClientSessionKillPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.expected_instance_id.as_deref(), Some("instance-a"));
}

#[test]
fn test_client_session_create_response_payload() {
    let payload = ClientSessionCreateResponsePayload {
        success: true,
        session_id: Some("agent-1:new-sess".to_string()),
        error: None,
        warnings: Vec::new(),
        project_id: None,
        sandbox: None,
        instance_id: None,
        metadata: None,
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
        error_kind: None,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ClientSessionKillResponsePayload = serde_json::from_str(&json).unwrap();
    assert!(decoded.success);
    assert!(
        !json.contains("error_kind"),
        "a success carries no refusal classification"
    );

    // #4302: a guarded refusal classifies itself; a legacy refusal decodes
    // without the field.
    let refused = ClientSessionKillResponsePayload {
        success: false,
        error: Some("expected instance a, current instance b".to_string()),
        error_kind: Some("conflict".to_string()),
    };
    let json = serde_json::to_string(&refused).unwrap();
    let decoded: ClientSessionKillResponsePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.error_kind.as_deref(), Some("conflict"));
    let legacy: ClientSessionKillResponsePayload =
        serde_json::from_str(r#"{"success":false,"error":"nope"}"#).unwrap();
    assert_eq!(legacy.error_kind, None);
}

#[test]
fn agent_session_kill_payload_carries_an_optional_incarnation_precondition() {
    // #4302: the Agent wire's kill request stays name-addressed for legacy
    // callers and carries the caller-observed instance for guarded ones.
    let legacy: SessionKillPayload = serde_json::from_str(r#"{"name":"dev"}"#).unwrap();
    assert_eq!(legacy.name, "dev");
    assert_eq!(legacy.expected_instance_id, None);
    let json = serde_json::to_string(&legacy).unwrap();
    assert!(!json.contains("expected_instance_id"));

    let guarded = SessionKillPayload {
        name: "dev".to_string(),
        expected_instance_id: Some("instance-a".to_string()),
    };
    let json = serde_json::to_string(&guarded).unwrap();
    let decoded: SessionKillPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.expected_instance_id.as_deref(), Some("instance-a"));
}

#[test]
fn web_session_kill_response_classifies_a_guarded_refusal() {
    // #4302: the Server-side declaration of the same kill reply wire carries
    // the identical optional classification.
    let legacy: WebSessionKillResponse =
        serde_json::from_str(r#"{"success":false,"error":"nope"}"#).unwrap();
    assert_eq!(legacy.error_kind, None);
    let refused = WebSessionKillResponse {
        success: false,
        error: Some("expected instance a, current instance b".to_string()),
        error_kind: Some("conflict".to_string()),
    };
    let json = serde_json::to_string(&refused).unwrap();
    let decoded: WebSessionKillResponse = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.error_kind.as_deref(), Some("conflict"));
    let success = WebSessionKillResponse {
        success: true,
        error: None,
        error_kind: None,
    };
    let json = serde_json::to_string(&success).unwrap();
    assert!(!json.contains("error_kind"));
}

// ---------------------------------------------------------------------------
// Session metadata (#2789)
// ---------------------------------------------------------------------------

#[test]
fn absent_metadata_is_revision_zero_and_old_payloads_stay_readable() {
    // A legacy Session has no file; the wire still answers the contract. A
    // payload written before the optional fields existed must decode, not
    // become an error the caller reads as "save failed".
    let empty: SessionMetadata = serde_json::from_str("{\"revision\":0}").unwrap();
    assert_eq!(empty.revision, 0);
    assert!(empty.title.is_none());
    assert!(empty.description.is_none());
    assert!(empty.tags.is_empty());
    assert!(empty.created_at.is_none());
    assert!(empty.updated_at.is_none());
    assert_eq!(empty.display_title("agent:work"), "agent:work");

    let update: SessionMetadataUpdatePayload =
        serde_json::from_str("{\"name\":\"work\",\"expected_revision\":0}").unwrap();
    assert!(update.title.is_none());
    assert!(update.description.is_none());
    assert!(update.tags.is_empty());
    assert_eq!(update.expected_revision, 0);
}

#[test]
fn initial_metadata_is_input_only_and_rejects_owner_written_fields() {
    let parsed: SessionInitialMetadata = serde_json::from_value(serde_json::json!({
        "title": " OAuth implementation ",
        "description": null,
        "tags": ["backend", "oauth"]
    }))
    .expect("a valid initial metadata object");
    assert_eq!(parsed.title.as_deref(), Some(" OAuth implementation "));
    assert!(parsed.description.is_none());
    assert_eq!(parsed.tags, vec!["backend", "oauth"]);

    for owner_written in [
        serde_json::json!({ "revision": 3 }),
        serde_json::json!({ "instance_id": "instance-a" }),
        serde_json::json!({ "created_at": 1 }),
        serde_json::json!({ "updated_at": 1 }),
        serde_json::json!({ "name": "other" }),
    ] {
        assert!(
            serde_json::from_value::<SessionInitialMetadata>(owner_written.clone()).is_err(),
            "owner-written/unknown field must be refused: {owner_written}"
        );
    }
}

#[test]
fn initial_metadata_uses_the_shared_normalization_and_bounds() {
    let normalized = SessionInitialMetadata {
        title: Some("  Release triage  ".to_string()),
        description: Some("  Fix staging  ".to_string()),
        tags: vec![" release ".to_string(), "Staging".to_string()],
    }
    .normalized()
    .expect("valid values");
    assert_eq!(normalized.title.as_deref(), Some("Release triage"));
    assert_eq!(normalized.description.as_deref(), Some("Fix staging"));
    assert_eq!(normalized.tags, vec!["release", "Staging"]);

    let too_long = SessionInitialMetadata {
        title: Some("x".repeat(SESSION_METADATA_TITLE_MAX_CHARS + 1)),
        ..SessionInitialMetadata::default()
    };
    assert_eq!(
        too_long.normalized().unwrap_err(),
        SessionMetadataValidationError::TitleTooLong {
            max: SESSION_METADATA_TITLE_MAX_CHARS
        }
    );
    let duplicate = SessionInitialMetadata {
        tags: vec!["same".to_string(), "SAME".to_string()],
        ..SessionInitialMetadata::default()
    };
    assert_eq!(
        duplicate.normalized().unwrap_err(),
        SessionMetadataValidationError::DuplicateTag { index: 1 }
    );
    let empty_tag = SessionInitialMetadata {
        tags: vec!["  ".to_string()],
        ..SessionInitialMetadata::default()
    };
    assert_eq!(
        empty_tag.normalized().unwrap_err(),
        SessionMetadataValidationError::EmptyTag { index: 0 }
    );
}

#[test]
fn create_payloads_accept_initial_metadata_additively() {
    // The field is absent for every pre-#4081 caller and round-trips when set.
    let minimal = serde_json::json!({"name": "work"});
    let direct: SessionCreatePayload = serde_json::from_value(minimal).unwrap();
    assert!(direct.initial_metadata.is_none());
    let web: WebSessionCreatePayload =
        serde_json::from_value(serde_json::json!({"agent_id": "a", "name": "work"})).unwrap();
    assert!(web.initial_metadata.is_none());

    let metadata = serde_json::json!({
        "title": "OAuth implementation",
        "description": "Goal: implement and validate the OAuth flow.",
        "tags": ["backend", "oauth"]
    });
    let direct: SessionCreatePayload = serde_json::from_value(serde_json::json!({
        "name": "work",
        "initial_metadata": metadata
    }))
    .unwrap();
    let initial = direct.initial_metadata.expect("initial metadata");
    assert_eq!(initial.title.as_deref(), Some("OAuth implementation"));
    assert_eq!(initial.normalized().unwrap().tags.len(), 2);
}

#[test]
fn metadata_round_trips_and_display_title_prefers_a_nonempty_title() {
    let metadata = SessionMetadata {
        revision: 3,
        title: Some("Release triage".to_string()),
        description: Some("Triage the failing staging run".to_string()),
        tags: vec!["release".to_string(), "staging".to_string()],
        created_at: Some(1_700_000_000),
        updated_at: Some(1_700_000_100),
    };
    let json = serde_json::to_string(&metadata).unwrap();
    let decoded: SessionMetadata = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded, metadata);
    assert_eq!(decoded.display_title("agent:work"), "Release triage");

    let blank = SessionMetadata {
        title: Some("   ".to_string()),
        ..metadata
    };
    assert_eq!(blank.display_title("agent:work"), "agent:work");
}

#[test]
fn metadata_validation_trims_and_counts_unicode_codepoints() {
    let normalized = validate_session_metadata(
        Some("  Release triage  "),
        Some("  Fix the staging run  "),
        &[" release ".to_string(), "Staging".to_string()],
    )
    .unwrap();
    assert_eq!(normalized.title.as_deref(), Some("Release triage"));
    assert_eq!(
        normalized.description.as_deref(),
        Some("Fix the staging run")
    );
    assert_eq!(normalized.tags, vec!["release", "Staging"]);

    // An empty title is absence, not a 0-length title: navigation falls back.
    let empty = validate_session_metadata(Some("   "), None, &[]).unwrap();
    assert!(empty.title.is_none());
    assert!(empty.description.is_none());

    // 120 scalars pass; 121 do not, even when the bytes are four per scalar.
    let at_limit = "𝄞".repeat(SESSION_METADATA_TITLE_MAX_CHARS);
    assert!(validate_session_metadata(Some(&at_limit), None, &[]).is_ok());
    let over = "𝄞".repeat(SESSION_METADATA_TITLE_MAX_CHARS + 1);
    assert_eq!(
        validate_session_metadata(Some(&over), None, &[]).unwrap_err(),
        SessionMetadataValidationError::TitleTooLong {
            max: SESSION_METADATA_TITLE_MAX_CHARS
        }
    );
    let description = "a".repeat(SESSION_METADATA_DESCRIPTION_MAX_CHARS + 1);
    assert_eq!(
        validate_session_metadata(None, Some(&description), &[]).unwrap_err(),
        SessionMetadataValidationError::DescriptionTooLong {
            max: SESSION_METADATA_DESCRIPTION_MAX_CHARS
        }
    );
}

#[test]
fn metadata_validation_rejects_invalid_tags() {
    assert_eq!(
        validate_session_metadata(None, None, &["  ".to_string()]).unwrap_err(),
        SessionMetadataValidationError::EmptyTag { index: 0 }
    );
    assert_eq!(
        validate_session_metadata(None, None, &["ok".to_string(), " OK ".to_string()]).unwrap_err(),
        SessionMetadataValidationError::DuplicateTag { index: 1 }
    );
    let too_long = "x".repeat(SESSION_METADATA_TAG_MAX_CHARS + 1);
    assert_eq!(
        validate_session_metadata(None, None, &[too_long]).unwrap_err(),
        SessionMetadataValidationError::TagTooLong {
            index: 0,
            max: SESSION_METADATA_TAG_MAX_CHARS
        }
    );
    let many: Vec<String> = (0..=SESSION_METADATA_TAG_LIMIT)
        .map(|index| format!("tag-{index}"))
        .collect();
    assert_eq!(
        validate_session_metadata(None, None, &many).unwrap_err(),
        SessionMetadataValidationError::TooManyTags {
            max: SESSION_METADATA_TAG_LIMIT
        }
    );
}

#[test]
fn metadata_patch_distinguishes_omitted_null_and_values() {
    let current = SessionMetadata {
        revision: 4,
        title: Some("Old title".to_string()),
        description: Some("Old description".to_string()),
        tags: vec!["alpha".to_string()],
        created_at: None,
        updated_at: None,
    };

    // Omitted fields preserve; explicit null clears; a value replaces.
    let patch: SessionMetadataPatch =
        serde_json::from_value(serde_json::json!({ "description": null })).unwrap();
    assert!(patch.title.is_none(), "omitted title must stay unspecified");
    assert_eq!(patch.description, Some(None), "null is an explicit clear");
    assert!(patch.tags.is_none(), "omitted tags preserve the list");
    assert_eq!(
        patch.apply(&current),
        (
            Some("Old title".to_string()),
            None,
            vec!["alpha".to_string()]
        )
    );

    let title: SessionMetadataPatch =
        serde_json::from_value(serde_json::json!({ "title": "New title" })).unwrap();
    assert_eq!(title.title, Some(Some("New title".to_string())));
    assert_eq!(
        title.apply(&current),
        (
            Some("New title".to_string()),
            Some("Old description".to_string()),
            vec!["alpha".to_string()]
        )
    );

    // `[]` clears tags; an omitted tag list is not the same state.
    let tags: SessionMetadataPatch =
        serde_json::from_value(serde_json::json!({ "tags": [] })).unwrap();
    assert_eq!(tags.tags, Some(Vec::new()));
    assert_eq!(
        tags.apply(&current),
        (
            Some("Old title".to_string()),
            Some("Old description".to_string()),
            Vec::new()
        )
    );

    let empty: SessionMetadataPatch = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(empty.is_empty());
    assert_eq!(
        empty.apply(&current),
        (
            current.title.clone(),
            current.description.clone(),
            current.tags.clone()
        )
    );

    let round_trip = serde_json::to_value(&patch).expect("patch json");
    assert_eq!(round_trip, serde_json::json!({ "description": null }));

    // An unknown patch field is refused rather than silently ignored: a
    // caller must never believe it changed something the owner never saw.
    assert!(
        serde_json::from_value::<SessionMetadataPatch>(serde_json::json!({
            "title": "New",
            "unknown_field": true
        }))
        .is_err()
    );
}

#[test]
fn metadata_patch_payload_requires_incarnation_and_revision() {
    let missing: Result<SessionMetadataPatchPayload, _> = serde_json::from_value(
        serde_json::json!({ "name": "work", "patch": { "description": "Next" } }),
    );
    assert!(
        missing.is_err(),
        "a partial update without an incarnation/revision has no safe merge base"
    );

    let payload: SessionMetadataPatchPayload = serde_json::from_value(serde_json::json!({
        "name": "work",
        "expected_instance_id": "instance-a",
        "expected_revision": 4,
        "patch": { "description": "Next" }
    }))
    .expect("guarded patch payload");
    assert_eq!(payload.expected_instance_id, "instance-a");
    assert_eq!(payload.expected_revision, 4);
    assert!(payload.patch.title.is_none());

    let web: WebSessionMetadataPatchPayload = serde_json::from_value(serde_json::json!({
        "session_id": "agent-a:work",
        "expected_instance_id": "instance-a",
        "expected_revision": 4,
        "patch": { "title": null }
    }))
    .expect("web patch payload");
    assert_eq!(web.session_id, "agent-a:work");
    assert_eq!(web.patch.title, Some(None));
}

#[test]
fn metadata_update_precondition_is_optional_and_additive() {
    // A previously written payload still decodes and keeps the legacy
    // unguarded behavior.
    let legacy: SessionMetadataUpdatePayload =
        serde_json::from_str("{\"name\":\"work\",\"expected_revision\":0}").unwrap();
    assert!(legacy.expected_instance_id.is_none());
    let web_legacy: WebSessionMetadataUpdatePayload =
        serde_json::from_str("{\"session_id\":\"a:work\",\"expected_revision\":0}").unwrap();
    assert!(web_legacy.expected_instance_id.is_none());

    let guarded: SessionMetadataUpdatePayload = serde_json::from_value(serde_json::json!({
        "name": "work",
        "expected_revision": 4,
        "expected_instance_id": "instance-a"
    }))
    .unwrap();
    assert_eq!(guarded.expected_instance_id.as_deref(), Some("instance-a"));
    let guarded_web: WebSessionMetadataUpdatePayload = serde_json::from_value(serde_json::json!({
        "session_id": "a:work",
        "expected_revision": 4,
        "expected_instance_id": "instance-a"
    }))
    .unwrap();
    assert_eq!(
        guarded_web.expected_instance_id.as_deref(),
        Some("instance-a")
    );
}

#[test]
fn metadata_response_carries_the_instance_identity() {
    let metadata = SessionMetadata {
        revision: 5,
        title: Some("Work".to_string()),
        description: None,
        tags: Vec::new(),
        created_at: Some(1),
        updated_at: Some(2),
    };
    let response = SessionMetadataResponse::success_for("instance-a".to_string(), metadata);
    let json = serde_json::to_value(&response).unwrap();
    assert_eq!(json["instance_id"], "instance-a");
    assert_eq!(json["metadata"]["revision"], 5);
    let decoded: SessionMetadataResponse = serde_json::from_value(json).unwrap();
    assert_eq!(decoded, response);

    // Older replies and failures omit the identity without failing to decode.
    let failed: SessionMetadataResponse =
        serde_json::from_str("{\"success\":false,\"error\":\"nope\",\"error_kind\":\"not_found\"}")
            .unwrap();
    assert!(failed.instance_id.is_none());
}

#[test]
fn session_list_metadata_availability_is_explicit() {
    let available: SessionMetadataAvailability = serde_json::from_value(serde_json::json!({
        "state": "available",
        "summary": { "revision": 0, "tags": [] }
    }))
    .unwrap();
    assert_eq!(
        available,
        SessionMetadataAvailability::available(SessionMetadataSummary {
            revision: 0,
            title: None,
            tags: Vec::new(),
        })
    );
    let unavailable: SessionMetadataAvailability =
        serde_json::from_value(serde_json::json!({ "state": "unavailable" })).unwrap();
    assert_eq!(unavailable, SessionMetadataAvailability::unavailable());
    assert_eq!(
        serde_json::to_value(&unavailable).unwrap(),
        serde_json::json!({ "state": "unavailable" })
    );

    let session: SessionInfo = serde_json::from_value(serde_json::json!({
        "name": "work",
        "created_at": 0,
        "window_count": 1,
        "attached_clients": 0,
        "width": 80,
        "height": 24,
        "foreground_command": null,
        "metadata": {
            "state": "available",
            "summary": { "revision": 2, "title": "Release triage", "tags": ["release"] }
        }
    }))
    .unwrap();
    assert_eq!(
        session.metadata,
        Some(SessionMetadataAvailability::available(
            SessionMetadataSummary {
                revision: 2,
                title: Some("Release triage".to_string()),
                tags: vec!["release".to_string()],
            }
        ))
    );

    // A legacy entry without the field decodes; the caller treats it as unknown.
    let legacy: SessionInfo = serde_json::from_value(serde_json::json!({
        "name": "work",
        "created_at": 0,
        "window_count": 1,
        "attached_clients": 0,
        "width": 80,
        "height": 24,
        "foreground_command": null
    }))
    .unwrap();
    assert!(legacy.metadata.is_none());

    let web: WebSessionInfo = serde_json::from_value(serde_json::json!({
        "session_id": "a:work",
        "agent_id": "agent-a",
        "session_name": "work",
        "status": "detached",
        "window_count": 1,
        "attached_clients": 0,
        "last_activity": "2026-11-19T00:00:00Z",
        "metadata": { "state": "unavailable" }
    }))
    .unwrap();
    assert_eq!(
        web.metadata,
        Some(SessionMetadataAvailability::unavailable())
    );
}

#[test]
fn sandbox_command_payloads_round_trip_with_empty_first_rows() {
    // #3124: the client sends the Web-safe draft; empty Resource/Syscall rows
    // survive the wire as an empty list, not as a fabricated option.
    let enter: ClientSessionSandboxEnterPayload = serde_json::from_value(serde_json::json!({
        "session_id": "agent:work",
        "generation": "gen-1",
        "probe_generation": "probe-1",
        "enter_id": "enter-1",
        "policy": {
            "enabled": true,
            "filesystem": { "access": { "read": ["/usr"], "write": ["/workspace"] } },
            "network": { "mode": "deny" },
            "resource": [],
            "syscall": []
        },
        "working_dir": "/workspace"
    }))
    .expect("the client draft must parse");
    assert!(enter.policy.resource.is_empty());
    let value = serde_json::to_value(&enter).unwrap();
    assert_eq!(value["policy"]["resource"], serde_json::json!([]));
    let parsed: ClientSessionSandboxEnterPayload = serde_json::from_value(value).unwrap();
    assert_eq!(parsed.enter_id, "enter-1");
    assert_eq!(parsed.probe_generation, "probe-1");

    // The Agent side carries the broker request id *and* the client's enter
    // id: correlation and idempotency are different identities.
    let agent: ServerSessionSandboxEnterPayload = serde_json::from_value(serde_json::json!({
        "request_id": "broker-1",
        "session_name": "work",
        "generation": "gen-1",
        "probe_generation": "probe-1",
        "enter_id": "enter-1",
        "policy": { "enabled": true, "resource": [{ "key": "memory.max", "value": "max" }] }
    }))
    .expect("the agent draft must parse");
    assert_eq!(agent.request_id, "broker-1");
    assert_eq!(agent.enter_id, "enter-1");
    assert_eq!(agent.probe_generation, "probe-1");
    assert_eq!(agent.policy.resource[0].key, "memory.max");

    // A client built before catalog v2 omits the probe generation; it parses
    // as empty and the Agent treats that as a stale, refused binding.
    let legacy: ClientSessionSandboxPreflightPayload = serde_json::from_value(serde_json::json!({
        "session_id": "agent:work",
        "generation": "gen-1",
        "policy": { "enabled": true }
    }))
    .expect("legacy payload remains readable");
    assert_eq!(legacy.probe_generation, "");
}

#[test]
fn sandbox_context_and_action_replies_round_trip() {
    let context = SandboxContextResponse {
        success: false,
        error: Some("Agent 'a' is offline".to_string()),
        context: None,
        cache_statuses: Vec::new(),
        cache_observations: Vec::new(),
    };
    let value = serde_json::to_value(&context).unwrap();
    assert_eq!(value["success"], false);
    assert!(value.get("context").is_none());

    let action = SandboxActionResult {
        success: false,
        error_kind: Some(crate::contracts::sandbox::v1::SandboxActionErrorKind::Conflict),
        error: Some("the Sandbox context changed; re-run preflight".to_string()),
        field_errors: None,
        context: None,
    };
    let value = serde_json::to_value(&action).unwrap();
    assert_eq!(value["error_kind"], "conflict");

    let preflight = SandboxPreflightResult {
        ok: false,
        error: None,
        generation: "gen-1".to_string(),
        policy_digest: None,
        backend: None,
        mechanisms: Vec::new(),
        errors: vec![SandboxFieldError {
            field: "resource[0].key".to_string(),
            code: "unknown-key".to_string(),
            message: "only the four V1 cgroup keys are accepted".to_string(),
        }],
        warnings: Vec::new(),
        catalog: crate::contracts::sandbox::v1::SandboxCapabilityCatalog {
            catalog_version: crate::contracts::sandbox::v1::SANDBOX_CATALOG_VERSION,
            status: crate::contracts::sandbox::v1::SandboxCatalogStatus::Available,
            platform: "linux".to_string(),
            backend: Some("linux-bwrap".to_string()),
            probe_generation: "probe-1".to_string(),
            source: "agent-host-probe".to_string(),
            detail: Vec::new(),
            reason: None,
            implementations: Vec::new(),
            resource_fields: Vec::new(),
            syscall_fields: Vec::new(),
        },
    };
    let value = serde_json::to_value(&preflight).unwrap();
    assert_eq!(value["errors"][0]["code"], "unknown-key");
    assert!(value.get("error").is_none());
}

// ---- Managed EROFS creation (#3062) ----

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn a_client_managed_create_round_trips_its_pinned_artifacts() {
    let payload: ClientSessionCreatePayload = serde_json::from_value(serde_json::json!({
        "agent_id": "agent-a",
        "name": "managed",
        "project_id": "project-00000000-0000-0000-0000-000000000001",
        "managed": {
            "base_digest": DIGEST_A,
            "toolchains": [{ "digest": DIGEST_B, "target": "/opt/rust" }]
        }
    }))
    .expect("a managed create parses");
    let managed = payload.managed.clone().expect("managed request");
    assert_eq!(managed.base_digest, DIGEST_A);
    assert_eq!(managed.toolchains.len(), 1);
    assert_eq!(managed.toolchains[0].digest, DIGEST_B);
    assert_eq!(managed.toolchains[0].target.as_deref(), Some("/opt/rust"));

    let encoded = serde_json::to_value(&payload).unwrap();
    let decoded: ClientSessionCreatePayload = serde_json::from_value(encoded).unwrap();
    assert_eq!(
        decoded.managed.unwrap().toolchains[0].target.as_deref(),
        Some("/opt/rust")
    );
}

#[test]
fn a_server_managed_create_carries_one_grant_per_role() {
    let payload: ServerSessionCreatePayload = serde_json::from_value(serde_json::json!({
        "request_id": "req-1",
        "name": "managed",
        "managed": {
            "images": [
                { "role": "base", "digest": DIGEST_A, "path": "/images/blobs/aaa" },
                { "role": "workspace", "digest": DIGEST_B, "path": "/images/blobs/bbb" },
                { "role": "toolchain", "digest": DIGEST_B, "path": "/images/blobs/bbb", "target": "/opt/rust" }
            ]
        }
    }))
    .expect("a server managed create parses");
    let images = payload.managed.clone().expect("managed images").images;
    assert_eq!(images[0].role, ManagedImageRole::Base);
    assert_eq!(images[1].role, ManagedImageRole::Workspace);
    assert_eq!(images[2].role, ManagedImageRole::Toolchain);
    assert_eq!(images[2].target.as_deref(), Some("/opt/rust"));
    let encoded = serde_json::to_value(&payload).unwrap();
    assert_eq!(encoded["managed"]["images"][0]["role"], "base");
    assert!(encoded["managed"]["images"][0].get("target").is_none());
}

#[test]
fn unknown_managed_fields_are_refused() {
    let client = serde_json::from_value::<ClientManagedCreate>(serde_json::json!({
        "base_digest": DIGEST_A,
        "unexpected": true
    }));
    assert!(client.is_err(), "an unknown managed key must be refused");

    let grant = serde_json::from_value::<ManagedImageGrant>(serde_json::json!({
        "role": "base",
        "digest": DIGEST_A,
        "path": "/images/blobs/aaa",
        "unexpected": true
    }));
    assert!(grant.is_err(), "an unknown grant key must be refused");

    let toolchain = serde_json::from_value::<ManagedToolchainRequest>(serde_json::json!({
        "digest": DIGEST_A,
        "target": "/opt/rust",
        "unexpected": true
    }));
    assert!(
        toolchain.is_err(),
        "an unknown toolchain key must be refused"
    );
}

/// #3796: the prepare request carries the user's explicit intent instead of
/// inferring a download from an observation read, and an unknown field is a
/// contract error rather than a silently ignored hint.
#[test]
fn an_image_prepare_request_carries_an_explicit_intent() {
    use crate::contracts::image::v1::{ImageCacheObservation, ImageCachePhase};

    let digest = format!("sha256:{}", "a".repeat(64));
    let payload: ClientSessionSandboxImagePreparePayload =
        serde_json::from_value(serde_json::json!({
            "session_id": "a1:s1",
            "digest": digest,
            "intent": "resume",
        }))
        .expect("a resume request is valid");
    assert_eq!(payload.intent, SandboxImagePrepareIntent::Resume);
    assert_eq!(payload.digest, digest);
    assert_eq!(
        serde_json::to_value(&payload).unwrap()["intent"],
        serde_json::json!("resume")
    );

    assert!(
        serde_json::from_value::<ClientSessionSandboxImagePreparePayload>(serde_json::json!({
            "session_id": "a1:s1",
            "digest": digest,
            "intent": "prepare",
            "download": true,
        }))
        .is_err(),
        "an extra field must not silently change a cache mutation"
    );
    assert!(
        serde_json::from_value::<ClientSessionSandboxImagePreparePayload>(serde_json::json!({
            "session_id": "a1:s1",
            "digest": digest,
            "intent": "download",
        }))
        .is_err(),
        "an unknown intent is refused rather than guessed"
    );

    let observation = ImageCacheObservation {
        contract_version: crate::contracts::image::v1::IMAGE_CACHE_OBSERVATION_VERSION,
        digest: format!("sha256:{}", "b".repeat(64)),
        phase: ImageCachePhase::Verifying,
        downloaded_bytes: Some(5),
        total_bytes: Some(10),
        active: true,
        updated_at: 1,
        detail: None,
    };
    observation.validate().unwrap();
    let reply = SandboxImagePrepareResponse {
        success: true,
        error: None,
        error_kind: None,
        observation: Some(observation.clone()),
        observations: vec![observation],
    };
    let round_trip: SandboxImagePrepareResponse =
        serde_json::from_value(serde_json::to_value(&reply).unwrap()).unwrap();
    assert_eq!(round_trip, reply);
}

#[test]
fn lowercase_slug_session_names_are_accepted() {
    for name in ["a", "z9", "work", "my-session", "a.b_c-1", "123", "a1"] {
        assert_eq!(validate_session_name(name), Ok(()), "accepts {name:?}");
    }
}

#[test]
fn mixed_case_and_path_like_session_names_are_rejected() {
    for name in [
        "Test",
        "TEST",
        "test space",
        "\ttest",
        "a/b",
        "a\\b",
        "a:b",
        ".hidden",
        "-hidden",
        "_hidden",
        "..",
        "中文",
        "café",
    ] {
        assert_eq!(
            validate_session_name(name),
            Err(SessionNameValidationError::Invalid),
            "rejects {name:?}"
        );
    }
    assert_eq!(
        validate_session_name(""),
        Err(SessionNameValidationError::Empty),
        "an absent name is its own refusal"
    );
}
