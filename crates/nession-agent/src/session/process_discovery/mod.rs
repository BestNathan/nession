//! Read-only process discovery for one tmux-backed Session (#2514).
//!
//! The Session domain owns this answer because it is the only layer that may
//! combine tmux Pane identity with node-local OS observation. It never mutates
//! anything: a snapshot can fail, degrade or truncate, and the terminal is not
//! affected either way.
//!
//! ## The two methods, and what each proves
//!
//! - **Dedicated per-Pane cgroup** (Linux only): tmux may place each Pane's
//!   spawn in a systemd scope named `tmux-spawn-<uuid>.scope`. When that scope
//!   exists, is verifiably dedicated to the Pane, and is readable, recursively
//!   reading its `cgroup.procs` observes membership including workers that were
//!   reparented inside the scope. `complete` means complete for that observed
//!   domain — not for every process the Session ever launched.
//! - **Process enumeration + PID/PPID recursion** (every platform): the Pane's
//!   root PID and its descendants. This is `partial` by construction: a
//!   daemonized worker that left the tree is not discoverable. SID/PGID/TTY are
//!   carried as lower-confidence evidence, never as proof of membership.
//!
//! The method is probed per Pane at query time, because support differs per
//! machine, per Pane and even over one Pane's lifetime.
//!
//! ## Bounds
//!
//! One snapshot is bounded by [`MAX_PROCESSES`], [`MAX_PANES`],
//! [`MAX_DEPTH`], [`MAX_COMMAND_BYTES`] and [`CPU_WINDOW`]. A bound that is
//! reached is reported (`truncated` plus a Pane reason code), not silently
//! applied.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use anyhow::Result;
use nession_protocol::contracts::session::v1::{
    DiscoveredProcess, PaneProcessSnapshot, ProcessCoverage, ProcessDiscoveryLimits,
    ProcessDiscoveryMethod, ProcessMetric, ProcessMetricState, ProcessSnapshot,
};

use crate::tmux::ops::TmuxDep;

mod redact;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "macos")]
mod macos;

/// Hard bound on processes in one Session snapshot.
const MAX_PROCESSES: usize = 512;
/// Hard bound on Panes in one Session snapshot.
const MAX_PANES: usize = 64;
/// Hard bound on PID/PPID recursion depth.
const MAX_DEPTH: usize = 32;
/// CPU/I-O are sampled over this window, and the wire says it is this window.
const CPU_WINDOW: Duration = Duration::from_millis(150);
/// Bound on the sanitized command display.
const MAX_COMMAND_BYTES: usize = 512;
/// Bound on the number of argv entries carried into the display.
const MAX_COMMAND_ARGS: usize = 32;
/// Bound on an executable string.
const MAX_EXECUTABLE_BYTES: usize = 256;

/// One Pane's membership as the platform layer resolved it.
///
/// A Pane snapshot is built from this plus the process table. Listing is kept
/// separate from the protocol type so the platform code does not depend on the
/// wire contract.
#[derive(Debug)]
struct PaneMembership {
    /// Unique Pane memberships: every Session that links this Window.
    session_ids: Vec<String>,
    session_names: Vec<String>,
    window_id: String,
    window_index: i32,
    window_name: String,
    pane_id: String,
    pane_index: i32,
    pane_pid: Option<u32>,
    pane_tty: Option<String>,
    method: ProcessDiscoveryMethod,
    coverage: ProcessCoverage,
    reason_codes: Vec<String>,
    pids: Vec<u32>,
    truncated: bool,
}

/// Static facts one platform read can produce for one process.
struct ProcessFacts {
    ppid: Option<u32>,
    pgid: Option<u32>,
    sid: Option<u32>,
    tty: Option<String>,
    start_time_ms: Option<i64>,
    rss_bytes: Option<u64>,
    threads: Option<u32>,
}

/// Facts that need a per-process read and are only fetched for members.
#[derive(Default)]
struct ProcessDetails {
    executable: Option<String>,
    /// Raw argv. Sanitized before the Agent→Server hop, never before.
    argv: Option<Vec<String>>,
    /// Whether the platform said the I/O counters were denied rather than
    /// absent. The two produce different wire states.
    io_denied: bool,
}

/// One CPU/I-O sample. `alive` distinguishes a zero counter from a dead PID.
struct Sample {
    cpu_ns: Option<u64>,
    io_read_bytes: Option<u64>,
    io_write_bytes: Option<u64>,
    alive: bool,
}

/// Discover one Session's read-only process snapshot.
///
/// `session_name` is authorized by the caller (the transport handler): this
/// function only reads Panes that are members of the named Session on this
/// Agent's private tmux server. A Session with no Panes is an error, because
/// "no such Session" and "a Session with an empty process tree" are different
/// answers.
pub(crate) async fn discover_session_processes(
    tmux: &TmuxDep,
    session_name: &str,
) -> Result<ProcessSnapshot> {
    // Pane identity is tmux-native and asynchronous; everything after it is
    // node-local and blocking, so it runs on a blocking task.
    let panes = tmux.ops().list_panes().await?;
    let session_name = session_name.to_string();
    tokio::task::spawn_blocking(move || discover_panes(&session_name, panes))
        .await
        .map_err(|e| anyhow::anyhow!("process discovery task failed: {e}"))?
}

/// The synchronous half: membership, sampling, projection.
fn discover_panes(
    session_name: &str,
    panes: Vec<nession_tmux::PaneSummary>,
) -> Result<ProcessSnapshot> {
    let mut memberships = group_panes(session_name, panes)?;
    let panes_truncated = memberships.len() > MAX_PANES;
    memberships.truncate(MAX_PANES);
    let snapshot_at_ms = chrono::Utc::now().timestamp_millis();

    let table = platform_table();
    let mut memberships = resolve_memberships(memberships, table.as_ref());
    apply_process_budget(&mut memberships);

    let member_pids: Vec<u32> = {
        let mut seen = HashSet::new();
        memberships
            .iter()
            .flat_map(|pane| pane.pids.iter().copied())
            .filter(|pid| seen.insert(*pid))
            .collect()
    };

    let details: HashMap<u32, ProcessDetails> = member_pids
        .iter()
        .map(|pid| (*pid, platform_details(*pid)))
        .collect();

    let first = platform_sample(&member_pids);
    std::thread::sleep(CPU_WINDOW);
    let second = platform_sample(&member_pids);

    let processes_by_pid = build_processes(
        &member_pids,
        table.as_ref(),
        &details,
        &first,
        &second,
        snapshot_at_ms,
    );

    let mut truncated = panes_truncated;
    let mut methods: Vec<ProcessDiscoveryMethod> = Vec::new();
    let mut pane_snapshots = Vec::with_capacity(memberships.len());
    for pane in memberships {
        truncated |= pane.truncated;
        if !methods.contains(&pane.method) {
            methods.push(pane.method);
        }
        let processes = pane
            .pids
            .iter()
            .filter_map(|pid| processes_by_pid.get(pid).cloned())
            .collect();
        pane_snapshots.push(PaneProcessSnapshot {
            session_ids: pane.session_ids,
            session_names: pane.session_names,
            window_id: pane.window_id,
            window_index: pane.window_index,
            window_name: pane.window_name,
            pane_id: pane.pane_id,
            pane_index: pane.pane_index,
            pane_pid: pane.pane_pid,
            pane_tty: pane.pane_tty,
            method: pane.method,
            coverage: pane.coverage,
            reason_codes: pane.reason_codes,
            processes,
        });
    }

    Ok(ProcessSnapshot {
        session_name: session_name.to_string(),
        snapshot_at_ms,
        platform: platform_name().to_string(),
        methods,
        panes: pane_snapshots,
        truncated,
        limits: ProcessDiscoveryLimits {
            max_processes: u32::try_from(MAX_PROCESSES).unwrap_or(u32::MAX),
            max_depth: u32::try_from(MAX_DEPTH).unwrap_or(u32::MAX),
            cpu_window_ms: u64::try_from(CPU_WINDOW.as_millis()).unwrap_or(u64::MAX),
        },
    })
}

/// Group tmux rows into Pane resources.
///
/// A linked Window yields one row per Session with the same `pane_id`; grouping
/// by `pane_id` is what prevents the same process from being counted twice,
/// while keeping every membership. Panes that are not members of the requested
/// Session are not part of its snapshot.
fn group_panes(
    session_name: &str,
    rows: Vec<nession_tmux::PaneSummary>,
) -> Result<Vec<PaneMembership>> {
    let mut order: Vec<String> = Vec::new();
    let mut grouped: HashMap<String, PaneMembership> = HashMap::new();
    let mut found_session = false;

    for row in rows {
        let is_member = row.session_name == session_name;
        if is_member {
            found_session = true;
        }
        let entry = grouped.entry(row.pane_id.clone()).or_insert_with(|| {
            order.push(row.pane_id.clone());
            PaneMembership {
                session_ids: Vec::new(),
                session_names: Vec::new(),
                window_id: row.window_id.clone(),
                window_index: row.window_index,
                window_name: row.window_name.clone(),
                pane_id: row.pane_id.clone(),
                pane_index: row.pane_index,
                pane_pid: row.pane_pid,
                pane_tty: row.pane_tty.clone(),
                method: ProcessDiscoveryMethod::Unavailable,
                coverage: ProcessCoverage::Unavailable,
                reason_codes: Vec::new(),
                pids: Vec::new(),
                truncated: false,
            }
        });
        // The Pane's own row and the linked rows agree on identity; the root
        // PID/TTY are read fresh from this row so a respawned Pane is never
        // represented by a stale root.
        entry.pane_pid = row.pane_pid;
        entry.pane_tty = row.pane_tty;
        if !entry.session_ids.contains(&row.session_id) {
            entry.session_ids.push(row.session_id);
        }
        if !entry.session_names.contains(&row.session_name) {
            entry.session_names.push(row.session_name);
        }
    }

    if !found_session {
        anyhow::bail!("session not found: {session_name}");
    }

    let members_only: Vec<PaneMembership> = order
        .into_iter()
        .filter_map(|pane_id| grouped.remove(&pane_id))
        .filter(|pane| pane.session_names.iter().any(|name| name == session_name))
        .collect();

    Ok(members_only)
}

/// Resolve every Pane's membership, preferring a verified dedicated cgroup.
fn resolve_memberships(
    panes: Vec<PaneMembership>,
    table: Option<&HashMap<u32, ProcessFacts>>,
) -> Vec<PaneMembership> {
    #[cfg(target_os = "linux")]
    let mut cgroup_claims: HashMap<String, Vec<usize>> = HashMap::new();

    // Probe every Pane before deciding, so two Panes claiming one scope are
    // both treated as shared rather than each claiming a dedicated domain.
    #[cfg(target_os = "linux")]
    for (index, pane) in panes.iter().enumerate() {
        let Some(pid) = pane.pane_pid else { continue };
        if let Ok(scope) = linux::dedicated_cgroup(pid) {
            cgroup_claims
                .entry(scope.path.clone())
                .or_default()
                .push(index);
        }
    }

    panes
        .into_iter()
        .enumerate()
        .map(|(index, mut pane)| {
            let _ = index;
            let Some(table) = table else {
                pane.method = ProcessDiscoveryMethod::Unavailable;
                pane.coverage = ProcessCoverage::Unavailable;
                pane.reason_codes
                    .push("process_table_unavailable".to_string());
                return pane;
            };

            let Some(root_pid) = pane.pane_pid else {
                pane.method = ProcessDiscoveryMethod::Unavailable;
                pane.coverage = ProcessCoverage::Unavailable;
                pane.reason_codes.push("pane_process_missing".to_string());
                return pane;
            };
            if !table.contains_key(&root_pid) {
                pane.method = ProcessDiscoveryMethod::Unavailable;
                pane.coverage = ProcessCoverage::Unavailable;
                pane.reason_codes.push("pane_process_missing".to_string());
                return pane;
            }

            #[cfg(target_os = "linux")]
            {
                if try_cgroup_membership(&mut pane, root_pid, index, &cgroup_claims, table) {
                    return pane;
                }
            }

            // Process-tree fallback.
            let (mut pids, truncated) = descendants(root_pid, table, MAX_PROCESSES, MAX_DEPTH);
            pids.sort_unstable();
            pane.method = ProcessDiscoveryMethod::ProcessTree;
            pane.coverage = ProcessCoverage::Partial;
            if pane.reason_codes.is_empty() {
                // No platform-specific probe reason was produced. Say which
                // platform fact caused the fallback instead of hiding it.
                let reason = if cfg!(target_os = "linux") {
                    "no_dedicated_cgroup"
                } else {
                    "platform_without_dedicated_cgroup"
                };
                pane.reason_codes.push(reason.to_string());
            }
            if table
                .get(&root_pid)
                .is_some_and(|root| root.tty.is_some() || root.sid.is_some())
            {
                pane.reason_codes.push("sid_tty_association".to_string());
            }
            pane.truncated = truncated;
            if truncated {
                pane.reason_codes.push("process_limit_reached".to_string());
            }
            pane.pids = pids;
            pane
        })
        .collect()
}

/// Decide whether a verified cgroup can answer this Pane.
///
/// Returns `true` when it filled the Pane; `false` leaves a reason code behind
/// for the process-tree fallback to explain.
#[cfg(target_os = "linux")]
fn try_cgroup_membership(
    pane: &mut PaneMembership,
    root_pid: u32,
    index: usize,
    claims: &HashMap<String, Vec<usize>>,
    table: &HashMap<u32, ProcessFacts>,
) -> bool {
    let _ = index;
    let scope = match linux::dedicated_cgroup(root_pid) {
        Ok(scope) => scope,
        Err(reason) => {
            pane.reason_codes.push(reason.to_string());
            return false;
        }
    };

    if claims
        .get(&scope.path)
        .is_some_and(|owners| owners.len() > 1)
    {
        pane.reason_codes.push("shared_cgroup".to_string());
        return false;
    }

    match linux::cgroup_members(&scope, root_pid, MAX_PROCESSES, MAX_DEPTH) {
        Ok(members) => {
            let mut pids: Vec<u32> = members.procs.into_iter().collect();
            pids.sort_unstable();
            // A descendant that left the dedicated cgroup is still
            // attributable through PPID. Include it, but the Pane is no longer
            // complete for its observed domain.
            let (descendants_of_root, truncated_desc) =
                descendants(root_pid, table, MAX_PROCESSES, MAX_DEPTH);
            let mut outside = false;
            for pid in descendants_of_root {
                if !pids.contains(&pid) {
                    pids.push(pid);
                    outside = true;
                }
            }
            pids.sort_unstable();
            pids.dedup();

            let truncated = members.truncated || truncated_desc || outside;
            pane.method = ProcessDiscoveryMethod::Cgroup;
            pane.coverage = if truncated {
                ProcessCoverage::Partial
            } else {
                ProcessCoverage::Complete
            };
            if members.truncated || truncated_desc {
                pane.reason_codes.push("process_limit_reached".to_string());
            }
            if outside {
                pane.reason_codes.push("process_outside_cgroup".to_string());
            }
            pane.truncated = truncated;
            pane.pids = pids;
            true
        }
        Err(reason) => {
            pane.reason_codes.push(reason.to_string());
            false
        }
    }
}

/// Shrink every Pane to the snapshot-wide process budget.
fn apply_process_budget(panes: &mut [PaneMembership]) {
    let mut remaining = MAX_PROCESSES;
    for pane in panes {
        if pane.pids.len() > remaining {
            pane.pids.truncate(remaining);
            pane.truncated = true;
            pane.coverage = if pane.coverage == ProcessCoverage::Complete {
                ProcessCoverage::Partial
            } else {
                pane.coverage
            };
            if !pane
                .reason_codes
                .iter()
                .any(|code| code == "process_limit_reached")
            {
                pane.reason_codes.push("process_limit_reached".to_string());
            }
        }
        remaining = remaining.saturating_sub(pane.pids.len());
    }
}

/// PID/PPID descendants of `root`, bounded by count and depth.
///
/// The root is included when it exists in the table. The second return value
/// says whether a bound cut the result.
fn descendants(
    root: u32,
    table: &HashMap<u32, ProcessFacts>,
    max_processes: usize,
    max_depth: usize,
) -> (Vec<u32>, bool) {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, facts) in table {
        if let Some(ppid) = facts.ppid {
            children.entry(ppid).or_default().push(*pid);
        }
    }

    let mut out = Vec::new();
    let mut queue = std::collections::VecDeque::new();
    if table.contains_key(&root) {
        out.push(root);
        queue.push_back((root, 0usize));
    }

    let mut truncated = false;
    while let Some((pid, depth)) = queue.pop_front() {
        if depth >= max_depth {
            if children.get(&pid).is_some_and(|kids| !kids.is_empty()) {
                truncated = true;
            }
            continue;
        }
        if let Some(kids) = children.get(&pid) {
            for kid in kids {
                if out.len() >= max_processes {
                    return (out, true);
                }
                if !out.contains(kid) {
                    out.push(*kid);
                    queue.push_back((*kid, depth + 1));
                }
            }
        }
    }
    (out, truncated)
}

/// Project the sampled facts into the wire shape.
fn build_processes(
    member_pids: &[u32],
    table: Option<&HashMap<u32, ProcessFacts>>,
    details: &HashMap<u32, ProcessDetails>,
    first: &HashMap<u32, Sample>,
    second: &HashMap<u32, Sample>,
    snapshot_at_ms: i64,
) -> HashMap<u32, DiscoveredProcess> {
    let table = match table {
        Some(table) => table,
        None => return HashMap::new(),
    };
    let window_seconds = CPU_WINDOW.as_secs_f64();

    member_pids
        .iter()
        .filter_map(|pid| {
            let facts = table.get(pid)?;
            let detail = details.get(pid);
            let raw_argv = detail.and_then(|detail| detail.argv.clone());
            let raw_executable = detail.and_then(|detail| detail.executable.clone());
            let executable = redact::bound(
                &raw_executable
                    .or_else(|| raw_argv.as_ref().and_then(|argv| argv.first().cloned()))
                    .unwrap_or_else(|| "[unknown]".to_string()),
                MAX_EXECUTABLE_BYTES,
            );
            let (command, redacted, truncated, command_state, command_reason) = match &raw_argv {
                Some(argv) if !argv.is_empty() => {
                    let (command, redacted, truncated) =
                        redact::sanitize(argv, MAX_COMMAND_BYTES, MAX_COMMAND_ARGS);
                    (
                        command,
                        redacted,
                        truncated,
                        ProcessMetricState::Sampled,
                        None,
                    )
                }
                // A kernel thread has an empty argv; its `comm` is the honest
                // display, not an unreadable command.
                Some(_) => (
                    executable.clone(),
                    false,
                    false,
                    ProcessMetricState::Sampled,
                    None,
                ),
                None => (
                    String::new(),
                    false,
                    false,
                    ProcessMetricState::Denied,
                    Some("command_unreadable".to_string()),
                ),
            };

            let cpu = match (first.get(pid), second.get(pid)) {
                (Some(a), Some(b)) if a.alive && b.alive => match (a.cpu_ns, b.cpu_ns) {
                    (Some(a), Some(b)) => ProcessMetric::sampled(
                        (b.saturating_sub(a) as f64 / 1_000_000_000.0) / window_seconds * 100.0,
                    ),
                    _ => ProcessMetric::unavailable(
                        ProcessMetricState::Unsupported,
                        "no_cpu_counter",
                    ),
                },
                (Some(_), Some(_)) => {
                    ProcessMetric::unavailable(ProcessMetricState::Stale, "process_exited")
                }
                _ => ProcessMetric::unavailable(ProcessMetricState::Unknown, "sample_unavailable"),
            };

            let io_denied = detail.is_some_and(|detail| detail.io_denied);
            let io = |a: Option<u64>, b: Option<u64>| match (a, b) {
                (Some(a), Some(b)) => {
                    ProcessMetric::sampled((b.saturating_sub(a) as f64 / 1024.0) / window_seconds)
                }
                _ if io_denied => {
                    ProcessMetric::unavailable(ProcessMetricState::Denied, "io_permission_denied")
                }
                _ => ProcessMetric::unavailable(ProcessMetricState::Unsupported, "no_io_counters"),
            };
            let (read_a, write_a) = first
                .get(pid)
                .map(|s| (s.io_read_bytes, s.io_write_bytes))
                .unwrap_or((None, None));
            let (read_b, write_b) = second
                .get(pid)
                .map(|s| (s.io_read_bytes, s.io_write_bytes))
                .unwrap_or((None, None));

            let rss = match facts.rss_bytes {
                Some(bytes) => ProcessMetric::sampled(bytes as f64 / (1024.0 * 1024.0)),
                None => {
                    ProcessMetric::unavailable(ProcessMetricState::Unsupported, "no_rss_available")
                }
            };
            let threads = match facts.threads {
                Some(count) => ProcessMetric::sampled(f64::from(count)),
                None => {
                    ProcessMetric::unavailable(ProcessMetricState::Unsupported, "no_thread_count")
                }
            };
            let elapsed = facts.start_time_ms.map_or_else(
                || ProcessMetric::unavailable(ProcessMetricState::Unknown, "no_start_time"),
                |start| ProcessMetric::sampled((snapshot_at_ms - start).max(0) as f64),
            );

            Some((
                *pid,
                DiscoveredProcess {
                    pid: *pid,
                    parent_pid: facts.ppid,
                    start_time_ms: facts.start_time_ms,
                    tty: facts.tty.clone(),
                    sid: facts.sid,
                    pgid: facts.pgid,
                    executable,
                    command,
                    command_state,
                    command_reason,
                    redacted,
                    truncated,
                    cpu_percent: cpu,
                    rss_mib: rss,
                    threads,
                    elapsed_ms: elapsed,
                    io_read_kib_per_s: io(read_a, read_b),
                    io_write_kib_per_s: io(write_a, write_b),
                },
            ))
        })
        .collect()
}

fn platform_name() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        "other"
    }
}

#[cfg(target_os = "linux")]
fn platform_table() -> Option<HashMap<u32, ProcessFacts>> {
    linux::table().ok()
}

#[cfg(target_os = "macos")]
fn platform_table() -> Option<HashMap<u32, ProcessFacts>> {
    macos::table().ok()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn platform_table() -> Option<HashMap<u32, ProcessFacts>> {
    None
}

#[cfg(target_os = "linux")]
fn platform_details(pid: u32) -> ProcessDetails {
    linux::details(pid)
}

#[cfg(target_os = "macos")]
fn platform_details(pid: u32) -> ProcessDetails {
    macos::details(pid)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn platform_details(_pid: u32) -> ProcessDetails {
    ProcessDetails::default()
}

#[cfg(target_os = "linux")]
fn platform_sample(pids: &[u32]) -> HashMap<u32, Sample> {
    linux::sample(pids)
}

#[cfg(target_os = "macos")]
fn platform_sample(pids: &[u32]) -> HashMap<u32, Sample> {
    macos::sample(pids)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn platform_sample(_pids: &[u32]) -> HashMap<u32, Sample> {
    HashMap::new()
}

#[cfg(test)]
mod tests;
