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
fn test_client_session_attach_reply_states_the_credential_deadline() {
    // #2645: the browser cannot parse the opaque token, so a reconnect learns
    // from this field whether it must ask for a new one.
    let reply: ClientSessionAttachReply = serde_json::from_value(serde_json::json!({
        "status": "success",
        "mode": "p2p",
        "session_id": "agent:session",
        "connection_token": "opaque",
        "connection_token_expires_at": "2026-11-02T12:00:00Z"
    }))
    .unwrap();
    let ClientSessionAttachReply::Attached(payload) = reply else {
        panic!("expected the attached arm");
    };
    assert_eq!(
        payload.connection_token_expires_at.as_deref(),
        Some("2026-11-02T12:00:00Z")
    );

    // Older Servers and relay replies omit it; decoding must stay compatible.
    let legacy: ClientSessionAttachReply = serde_json::from_value(serde_json::json!({
        "status": "success",
        "mode": "relay",
        "session_id": "agent:session"
    }))
    .unwrap();
    let ClientSessionAttachReply::Attached(legacy) = legacy else {
        panic!("expected the attached arm");
    };
    assert_eq!(legacy.connection_token_expires_at, None);
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
        sandbox: None,
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
        sandbox: None,
        project_id: None,
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
        warnings: Vec::new(),
        project_id: None,
        sandbox: None,
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
