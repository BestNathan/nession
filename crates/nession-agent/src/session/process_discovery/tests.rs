//! Unit tests for the platform-independent halves of process discovery.

use super::*;
use nession_tmux::PaneSummary;

fn row(
    session_id: &str,
    session_name: &str,
    window_id: &str,
    pane_id: &str,
    pane_pid: Option<u32>,
) -> PaneSummary {
    PaneSummary {
        session_id: session_id.to_string(),
        session_name: session_name.to_string(),
        window_id: window_id.to_string(),
        window_index: 1,
        window_name: "editor".to_string(),
        pane_id: pane_id.to_string(),
        pane_index: 0,
        pane_pid,
        pane_tty: Some("/dev/pts/1".to_string()),
        window_linked: true,
    }
}

fn facts(ppid: u32) -> ProcessFacts {
    ProcessFacts {
        ppid: Some(ppid),
        pgid: Some(ppid),
        sid: Some(ppid),
        tty: Some("/dev/pts/1".to_string()),
        start_time_ms: Some(1_000),
        rss_bytes: Some(2 * 1024 * 1024),
        threads: Some(4),
    }
}

#[test]
fn a_linked_window_is_one_pane_with_every_membership() {
    // tmux prints the same Pane once per linking Session. The snapshot must
    // keep both memberships and list the process once.
    let panes = group_panes(
        "alpha",
        vec![
            row("$0", "alpha", "@1", "%1", Some(42)),
            row("$1", "beta", "@1", "%1", Some(42)),
        ],
    )
    .unwrap();
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0].pane_id, "%1");
    assert_eq!(panes[0].session_ids, vec!["$0", "$1"]);
    assert_eq!(panes[0].session_names, vec!["alpha", "beta"]);
}

#[test]
fn a_pane_outside_the_requested_session_is_not_in_its_snapshot() {
    let panes = group_panes(
        "alpha",
        vec![
            row("$0", "alpha", "@0", "%0", Some(1)),
            row("$1", "beta", "@1", "%1", Some(2)),
        ],
    )
    .unwrap();
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0].pane_id, "%0");
}

#[test]
fn an_unknown_session_is_an_error_not_an_empty_answer() {
    let error = group_panes("missing", vec![row("$1", "beta", "@1", "%1", Some(2))])
        .expect_err("no Pane belongs to the requested Session");
    assert!(error.to_string().contains("session not found"));
}

#[test]
fn descendants_include_the_root_and_respect_depth() {
    let table: HashMap<u32, ProcessFacts> = [
        (10, facts(1)),
        (11, facts(10)),
        (12, facts(11)),
        (13, facts(12)),
        (99, facts(1)),
    ]
    .into_iter()
    .collect();

    let (pids, truncated) = descendants(10, &table, 16, 32);
    assert_eq!(pids, vec![10, 11, 12, 13]);
    assert!(!truncated);

    let (shallow, truncated) = descendants(10, &table, 16, 1);
    assert_eq!(shallow, vec![10, 11]);
    assert!(truncated, "cutting a child edge is not a complete answer");

    let (capped, truncated) = descendants(10, &table, 2, 32);
    assert_eq!(capped.len(), 2);
    assert!(truncated);
}

#[test]
fn a_missing_pane_root_is_not_mistaken_for_an_empty_tree() {
    let table: HashMap<u32, ProcessFacts> = [(7, facts(1))].into_iter().collect();
    let panes = resolve_memberships(
        vec![PaneMembership {
            session_ids: vec!["$0".to_string()],
            session_names: vec!["s".to_string()],
            window_id: "@0".to_string(),
            window_index: 0,
            window_name: "w".to_string(),
            pane_id: "%0".to_string(),
            pane_index: 0,
            pane_pid: Some(42),
            pane_tty: None,
            method: ProcessDiscoveryMethod::Unavailable,
            coverage: ProcessCoverage::Unavailable,
            reason_codes: Vec::new(),
            pids: Vec::new(),
            truncated: false,
        }],
        Some(&table),
    );
    assert_eq!(panes[0].coverage, ProcessCoverage::Unavailable);
    assert!(panes[0]
        .reason_codes
        .contains(&"pane_process_missing".to_string()));
}

#[test]
fn the_process_budget_marks_the_pane_that_was_cut() {
    let mut panes = vec![
        PaneMembership {
            session_ids: vec![],
            session_names: vec![],
            window_id: "@0".to_string(),
            window_index: 0,
            window_name: "w".to_string(),
            pane_id: "%0".to_string(),
            pane_index: 0,
            pane_pid: Some(1),
            pane_tty: None,
            method: ProcessDiscoveryMethod::ProcessTree,
            coverage: ProcessCoverage::Partial,
            reason_codes: vec![],
            pids: vec![1; MAX_PROCESSES],
            truncated: false,
        },
        PaneMembership {
            session_ids: vec![],
            session_names: vec![],
            window_id: "@1".to_string(),
            window_index: 1,
            window_name: "w".to_string(),
            pane_id: "%1".to_string(),
            pane_index: 1,
            pane_pid: Some(2),
            pane_tty: None,
            method: ProcessDiscoveryMethod::ProcessTree,
            coverage: ProcessCoverage::Partial,
            reason_codes: vec![],
            pids: vec![2],
            truncated: false,
        },
    ];
    apply_process_budget(&mut panes);
    assert_eq!(panes[0].pids.len(), MAX_PROCESSES);
    assert!(panes[1].pids.is_empty());
    assert!(panes[1].truncated);
    assert!(panes[1]
        .reason_codes
        .contains(&"process_limit_reached".to_string()));
}

#[test]
fn sampled_metrics_keep_their_units_and_missing_ones_keep_their_reason() {
    let table: HashMap<u32, ProcessFacts> = [(42, facts(1))].into_iter().collect();
    let mut details = HashMap::new();
    details.insert(
        42,
        ProcessDetails {
            executable: Some("/usr/bin/tool".to_string()),
            argv: Some(vec![
                "tool".to_string(),
                "--token".to_string(),
                "secret".to_string(),
            ]),
            io_denied: false,
        },
    );
    let first = HashMap::from([(
        42,
        Sample {
            cpu_ns: Some(0),
            io_read_bytes: Some(0),
            io_write_bytes: Some(0),
            alive: true,
        },
    )]);
    let second = HashMap::from([(
        42,
        Sample {
            // 300 ms of CPU over a 150 ms wall-clock window is 200% of one
            // logical CPU, and that is a valid answer.
            cpu_ns: Some(300_000_000),
            io_read_bytes: Some(153_600),
            io_write_bytes: Some(0),
            alive: true,
        },
    )]);

    let processes = build_processes(&[42], Some(&table), &details, &first, &second, 61_000);
    let process = &processes[&42];

    assert_eq!(process.command, "tool --token [REDACTED]");
    assert!(process.redacted);
    assert_eq!(process.command_state, ProcessMetricState::Sampled);
    assert_eq!(process.cpu_percent.state, ProcessMetricState::Sampled);
    assert!((process.cpu_percent.value.unwrap() - 200.0).abs() < 0.001);
    assert!((process.rss_mib.value.unwrap() - 2.0).abs() < 0.001);
    assert_eq!(process.threads.value, Some(4.0));
    assert_eq!(process.elapsed_ms.value, Some(60_000.0));
    // 153600 bytes over 0.15 s = 1000 KiB/s.
    assert!((process.io_read_kib_per_s.value.unwrap() - 1000.0).abs() < 0.001);
    assert_eq!(process.io_write_kib_per_s.value, Some(0.0));
}

#[test]
fn an_unreadable_command_is_not_an_empty_command() {
    let table: HashMap<u32, ProcessFacts> = [(42, facts(1))].into_iter().collect();
    let first = HashMap::from([(
        42,
        Sample {
            cpu_ns: Some(0),
            io_read_bytes: None,
            io_write_bytes: None,
            alive: true,
        },
    )]);
    let second = HashMap::from([(
        42,
        Sample {
            cpu_ns: Some(0),
            io_read_bytes: None,
            io_write_bytes: None,
            alive: true,
        },
    )]);
    let details = HashMap::from([(
        42,
        ProcessDetails {
            executable: Some("/usr/bin/tool".to_string()),
            argv: None,
            io_denied: true,
        },
    )]);

    let processes = build_processes(&[42], Some(&table), &details, &first, &second, 61_000);
    let process = &processes[&42];
    assert_eq!(process.command, "");
    assert_eq!(process.command_state, ProcessMetricState::Denied);
    assert_eq!(
        process.command_reason.as_deref(),
        Some("command_unreadable")
    );
    assert_eq!(process.io_read_kib_per_s.state, ProcessMetricState::Denied);
    assert_eq!(
        process.io_read_kib_per_s.reason.as_deref(),
        Some("io_permission_denied")
    );
}

#[test]
fn a_process_that_exited_during_the_window_is_stale_not_zero() {
    let table: HashMap<u32, ProcessFacts> = [(42, facts(1))].into_iter().collect();
    let first = HashMap::from([(
        42,
        Sample {
            cpu_ns: Some(10),
            io_read_bytes: Some(10),
            io_write_bytes: Some(10),
            alive: true,
        },
    )]);
    let second = HashMap::from([(
        42,
        Sample {
            cpu_ns: None,
            io_read_bytes: None,
            io_write_bytes: None,
            alive: false,
        },
    )]);
    let details = HashMap::from([(42, ProcessDetails::default())]);

    let processes = build_processes(&[42], Some(&table), &details, &first, &second, 61_000);
    let process = &processes[&42];
    assert_eq!(process.cpu_percent.state, ProcessMetricState::Stale);
    assert_eq!(process.cpu_percent.value, None);
}

/// A real isolated tmux server, through the SDK, on this platform.
///
/// The Pane root is a shell; a background `sleep` is a descendant whose argv,
/// identity and metrics the snapshot must report. This is the end-to-end proof
/// that the platform readers, the Pane query and the projection agree — the
/// unit tests above can only prove each half.
#[cfg(unix)]
#[test]
fn a_real_isolated_session_reports_its_pane_and_descendants() {
    use nession_tmux::{NewSession, TmuxCommand, TmuxOps};

    let dir = tempfile::tempdir().expect("tempdir");
    let socket = dir.path().join("tmux.sock");
    let ops = TmuxOps::new(TmuxCommand::new("tmux", socket));
    let name = format!("process-discovery-{}", std::process::id());

    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    runtime.block_on(async {
        ops.new_session(&NewSession {
            name: name.clone(),
            working_dir: dir.path().to_string_lossy().into_owned(),
            width: 80,
            height: 24,
            env: Vec::new(),
        })
        .await
        .expect("create a real isolated session");
        ops.send_keys(&name, "sleep 30 &")
            .await
            .expect("type the background child");
        ops.send_keys(&name, "Enter")
            .await
            .expect("submit the command");
    });

    // The child appears asynchronously. Poll a bounded number of times instead
    // of assuming one scheduling point is enough.
    let mut snapshot = None;
    for _ in 0..50 {
        let panes = runtime
            .block_on(ops.list_panes())
            .expect("list panes on the real server");
        let candidate = discover_panes(
            &name,
            panes
                .into_iter()
                .filter(|pane| pane.session_name == name)
                .collect(),
        )
        .expect("the session exists");
        let saw_sleep = candidate.panes.iter().any(|pane| {
            pane.processes
                .iter()
                .any(|process| process.command.starts_with("sleep 30"))
        });
        if saw_sleep {
            snapshot = Some(candidate);
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let result = snapshot.expect("the background child is discovered");
    runtime.block_on(ops.kill_session(&name)).ok();

    assert_eq!(result.session_name, name);
    assert_eq!(result.panes.len(), 1);
    let pane = &result.panes[0];
    assert_eq!(pane.method, ProcessDiscoveryMethod::ProcessTree);
    assert_eq!(pane.coverage, ProcessCoverage::Partial);
    assert!(pane
        .reason_codes
        .iter()
        .any(|code| code == "platform_without_dedicated_cgroup" || code == "no_dedicated_cgroup"));
    assert!(pane
        .reason_codes
        .iter()
        .any(|code| code == "sid_tty_association"));
    assert!(pane.pane_pid.is_some());

    let root = result
        .panes
        .iter()
        .flat_map(|pane| pane.processes.iter())
        .find(|process| process.pid == pane.pane_pid.unwrap())
        .expect("the Pane root is in its own membership");
    let sleep = result
        .panes
        .iter()
        .flat_map(|pane| pane.processes.iter())
        .find(|process| process.command.starts_with("sleep 30"))
        .expect("the background child");
    assert_eq!(sleep.parent_pid, Some(root.pid));
    assert!(sleep.start_time_ms.is_some());
    assert_eq!(sleep.command_state, ProcessMetricState::Sampled);
    assert!(!sleep.redacted);
    assert_eq!(sleep.rss_mib.state, ProcessMetricState::Sampled);
    assert!(sleep.rss_mib.value.unwrap() > 0.0);
    assert_eq!(sleep.elapsed_ms.state, ProcessMetricState::Sampled);
    assert_eq!(sleep.cpu_percent.state, ProcessMetricState::Sampled);
}
