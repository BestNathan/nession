//! Linux process observation: `/proc` plus verified cgroup v2 scopes.
//!
//! Everything here is a read. The module deliberately does not distinguish a
//! process it cannot read from a process that does not exist beyond what the
//! filesystem says: callers report what they observed and never guess.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::{ProcessDetails, ProcessFacts, Sample};

const PROC_ROOT: &str = "/proc";
const CGROUP_ROOT: &str = "/sys/fs/cgroup";
const MAX_CGROUP_PROC_BYTES: u64 = 1024 * 1024;

/// A cgroup that looks like a dedicated per-Pane tmux scope.
pub(super) struct CgroupScope {
    pub path: String,
    pub dir: PathBuf,
}

/// The PIDs found in one cgroup tree.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct CgroupMembers {
    pub procs: Vec<u32>,
    pub truncated: bool,
}

/// Read every readable `/proc/<pid>/stat` once.
pub(super) fn table() -> std::io::Result<HashMap<u32, ProcessFacts>> {
    table_at(Path::new(PROC_ROOT))
}

fn table_at(proc_root: &Path) -> std::io::Result<HashMap<u32, ProcessFacts>> {
    let hz = clock_ticks();
    let page = page_size();
    let boot_ms = boot_time_ms(proc_root);
    let mut out = HashMap::new();

    for entry in fs::read_dir(proc_root)? {
        let Ok(entry) = entry else { continue };
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Some(stat) = read_stat(&entry.path().join("stat")) else {
            // The process exited between readdir and open; a snapshot is a
            // point-in-time observation, not a census of what used to exist.
            continue;
        };
        out.insert(
            pid,
            ProcessFacts {
                ppid: Some(stat.ppid),
                pgid: Some(stat.pgid),
                sid: Some(stat.sid),
                tty: tty_name(stat.tty_nr),
                start_time_ms: Some(boot_ms + ticks_to_ms(stat.start_ticks, hz)),
                rss_bytes: Some(stat.rss_pages.saturating_mul(page)),
                threads: Some(stat.threads),
            },
        );
    }
    Ok(out)
}

/// Read the command and I/O counters for one member.
pub(super) fn details(pid: u32) -> ProcessDetails {
    let proc = PathBuf::from(PROC_ROOT).join(pid.to_string());

    let argv = fs::read(proc.join("cmdline")).ok().map(|bytes| {
        bytes
            .split(|byte| *byte == 0)
            .filter(|part| !part.is_empty())
            .map(|part| String::from_utf8_lossy(part).into_owned())
            .collect()
    });
    let executable = fs::read_link(proc.join("exe"))
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
        .or_else(|| {
            fs::read_to_string(proc.join("comm"))
                .ok()
                .map(|comm| comm.trim().to_string())
        });

    // The counters themselves come from the two timed samples; this read only
    // distinguishes "denied" from "the platform has no counters".
    let io_denied = matches!(
        fs::read_to_string(proc.join("io")),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied
    );

    ProcessDetails {
        executable,
        argv,
        io_denied,
    }
}

/// Re-read CPU time and I/O counters for the sampling delta.
pub(super) fn sample(pids: &[u32]) -> HashMap<u32, Sample> {
    let hz = clock_ticks();
    pids.iter()
        .map(|pid| {
            let proc = PathBuf::from(PROC_ROOT).join(pid.to_string());
            let stat = read_stat(&proc.join("stat"));
            let io = fs::read_to_string(proc.join("io")).ok();
            (
                *pid,
                Sample {
                    cpu_ns: stat
                        .as_ref()
                        .map(|stat| ticks_to_ns(stat.utime_ticks + stat.stime_ticks, hz)),
                    io_read_bytes: io
                        .as_ref()
                        .and_then(|contents| parse_io_field(contents, "read_bytes:")),
                    io_write_bytes: io
                        .as_ref()
                        .and_then(|contents| parse_io_field(contents, "write_bytes:")),
                    alive: stat.is_some(),
                },
            )
        })
        .collect()
}

/// A verified dedicated per-Pane cgroup, or the reason there is none.
pub(super) fn dedicated_cgroup(pid: u32) -> Result<CgroupScope, &'static str> {
    dedicated_cgroup_at(Path::new(PROC_ROOT), Path::new(CGROUP_ROOT), pid)
}

fn dedicated_cgroup_at(
    proc_root: &Path,
    cgroup_root: &Path,
    pid: u32,
) -> Result<CgroupScope, &'static str> {
    let contents = fs::read_to_string(proc_root.join(pid.to_string()).join("cgroup"))
        .map_err(|_| "cgroup_unreadable")?;
    let Some(relative) = contents
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(str::trim)
    else {
        return Err("cgroup_v1_unsupported");
    };
    if relative.is_empty() || !relative.starts_with('/') {
        return Err("cgroup_unreadable");
    }
    if relative.split('/').any(|part| part == "..") {
        return Err("cgroup_unreadable");
    }
    let last = relative.rsplit('/').find(|part| !part.is_empty());
    let dedicated =
        last.is_some_and(|name| name.starts_with("tmux-spawn-") && name.ends_with(".scope"));
    if !dedicated {
        return Err("no_dedicated_cgroup");
    }
    if !cgroup_root.is_dir() {
        return Err("cgroup_unavailable");
    }
    let dir = cgroup_root.join(relative.trim_start_matches('/'));
    if !dir.is_dir() {
        return Err("cgroup_unreadable");
    }
    Ok(CgroupScope {
        path: relative.to_string(),
        dir,
    })
}

/// Recursively read a scope's `cgroup.procs`, proving the Pane root is in it.
pub(super) fn cgroup_members(
    scope: &CgroupScope,
    pane_pid: u32,
    max_processes: usize,
    max_depth: usize,
) -> Result<CgroupMembers, &'static str> {
    let mut procs = Vec::new();
    let mut truncated = false;
    let mut stack = vec![(scope.dir.clone(), 0usize)];

    while let Some((dir, depth)) = stack.pop() {
        let contents =
            fs::read_to_string(dir.join("cgroup.procs")).map_err(|_| "cgroup_unreadable")?;
        if u64::try_from(contents.len()).unwrap_or(u64::MAX) > MAX_CGROUP_PROC_BYTES {
            return Err("cgroup_unreadable");
        }
        for line in contents.lines() {
            if let Ok(pid) = line.trim().parse::<u32>() {
                if !procs.contains(&pid) {
                    procs.push(pid);
                }
                if procs.len() >= max_processes {
                    truncated = true;
                    break;
                }
            }
        }
        if truncated {
            break;
        }
        if depth >= max_depth {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                stack.push((entry.path(), depth + 1));
            }
        }
    }

    if !procs.contains(&pane_pid) {
        // The scope exists but does not contain the Pane's root. It is not
        // evidence for this Pane; do not associate other processes with it.
        return Err("cgroup_pane_pid_missing");
    }
    if procs.contains(&std::process::id()) {
        // The Agent itself is in this cgroup: it is shared, not per-Pane.
        return Err("shared_cgroup");
    }

    procs.sort_unstable();
    Ok(CgroupMembers { procs, truncated })
}

struct Stat {
    ppid: u32,
    pgid: u32,
    sid: u32,
    tty_nr: i64,
    utime_ticks: u64,
    stime_ticks: u64,
    threads: u32,
    start_ticks: u64,
    rss_pages: u64,
}

/// Parse one `/proc/<pid>/stat`.
///
/// `comm` may contain spaces and parentheses; the field list begins after the
/// **last** `)`, which is the only unambiguous boundary in this format.
fn read_stat(path: &Path) -> Option<Stat> {
    let contents = fs::read_to_string(path).ok()?;
    let close = contents.rfind(')')?;
    let rest = contents.get(close + 1..)?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    if fields.len() < 22 {
        return None;
    }
    Some(Stat {
        ppid: fields.get(1)?.parse().ok()?,
        pgid: fields.get(2)?.parse().ok()?,
        sid: fields.get(3)?.parse().ok()?,
        tty_nr: fields.get(4)?.parse().ok()?,
        utime_ticks: fields.get(11)?.parse().ok()?,
        stime_ticks: fields.get(12)?.parse().ok()?,
        threads: fields.get(17)?.parse().ok()?,
        start_ticks: fields.get(19)?.parse().ok()?,
        rss_pages: fields.get(21)?.parse().ok()?,
    })
}

fn parse_io_field(contents: &str, key: &str) -> Option<u64> {
    contents
        .lines()
        .find_map(|line| line.strip_prefix(key))
        .and_then(|value| value.trim().parse().ok())
}

fn clock_ticks() -> u64 {
    // SAFETY: sysconf is a pure query with no pointer arguments.
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if ticks <= 0 {
        // The POSIX default; every Linux libc reports the real value.
        100
    } else {
        u64::try_from(ticks).unwrap_or(100)
    }
}

fn page_size() -> u64 {
    // SAFETY: as above.
    let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if size <= 0 {
        4096
    } else {
        u64::try_from(size).unwrap_or(4096)
    }
}

/// Convert stat clock ticks to nanoseconds.
fn ticks_to_ns(ticks: u64, hz: u64) -> u64 {
    ticks.saturating_mul(1_000_000_000) / hz.max(1)
}

fn ticks_to_ms(ticks: u64, hz: u64) -> i64 {
    i64::try_from(ticks.saturating_mul(1000) / hz.max(1)).unwrap_or(i64::MAX)
}

/// Wall-clock boot time, from `/proc/stat`'s `btime`, with an uptime fallback.
fn boot_time_ms(proc_root: &Path) -> i64 {
    if let Ok(stat) = fs::read_to_string(proc_root.join("stat")) {
        if let Some(btime) = stat.lines().find_map(|line| line.strip_prefix("btime ")) {
            if let Ok(seconds) = btime.trim().parse::<i64>() {
                return seconds.saturating_mul(1000);
            }
        }
    }
    let uptime = fs::read_to_string(proc_root.join("uptime"))
        .ok()
        .and_then(|contents| {
            contents
                .split_whitespace()
                .next()
                .and_then(|seconds| seconds.parse::<f64>().ok())
        })
        .unwrap_or(0.0);
    let now_ms = chrono::Utc::now().timestamp_millis();
    now_ms.saturating_sub(i64::try_from(uptime * 1000.0).unwrap_or(0))
}

/// Render a Linux tty device number the way a user would name it.
fn tty_name(tty_nr: i64) -> Option<String> {
    if tty_nr == 0 {
        return None;
    }
    let major = (tty_nr >> 8) & 0xfff;
    let minor = (tty_nr & 0xff) | ((tty_nr >> 12) & 0xfff00);
    match major {
        136 => Some(format!("/dev/pts/{minor}")),
        4 => Some(format!("/dev/tty{minor}")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn a_tmux_scope_is_recognized_and_resolved_under_the_cgroup_root() {
        let root = tempfile::tempdir().unwrap();
        let proc_root = root.path().join("proc");
        let cgroup_root = root.path().join("cgroup");
        write(
            &proc_root.join("42/cgroup"),
            "0::/user.slice/user-1000.slice/tmux-spawn-abc.scope\n",
        );
        fs::create_dir_all(cgroup_root.join("user.slice/user-1000.slice/tmux-spawn-abc.scope"))
            .unwrap();

        let scope = dedicated_cgroup_at(&proc_root, &cgroup_root, 42).unwrap();
        assert_eq!(
            scope.path,
            "/user.slice/user-1000.slice/tmux-spawn-abc.scope"
        );
    }

    #[test]
    fn a_shared_or_ordinary_cgroup_is_not_a_dedicated_scope() {
        let root = tempfile::tempdir().unwrap();
        let proc_root = root.path().join("proc");
        let cgroup_root = root.path().join("cgroup");
        write(
            &proc_root.join("42/cgroup"),
            "0::/system.slice/docker-abc.scope\n",
        );
        assert_eq!(
            dedicated_cgroup_at(&proc_root, &cgroup_root, 42),
            Err("no_dedicated_cgroup")
        );
    }

    #[test]
    fn a_cgroup_v1_process_falls_back_with_its_own_reason() {
        let root = tempfile::tempdir().unwrap();
        let proc_root = root.path().join("proc");
        write(
            &proc_root.join("42/cgroup"),
            "12:memory:/\n1:name=systemd:/\n",
        );
        assert_eq!(
            dedicated_cgroup_at(&proc_root, root.path(), 42),
            Err("cgroup_v1_unsupported")
        );
    }

    #[test]
    fn cgroup_membership_reads_nested_scopes_and_proves_the_pane_root() {
        let root = tempfile::tempdir().unwrap();
        let scope_dir = root.path().join("scope");
        write(&scope_dir.join("cgroup.procs"), "42\n43\n");
        write(&scope_dir.join("child/cgroup.procs"), "44\n");

        let members = cgroup_members(
            &CgroupScope {
                path: "/scope".to_string(),
                dir: scope_dir,
            },
            42,
            super::super::MAX_PROCESSES,
            super::super::MAX_DEPTH,
        )
        .unwrap();
        assert_eq!(members.procs, vec![42, 43, 44]);
        assert!(!members.truncated);
    }

    #[test]
    fn a_scope_without_the_pane_root_is_not_evidence() {
        let root = tempfile::tempdir().unwrap();
        write(&root.path().join("scope/cgroup.procs"), "43\n");
        assert_eq!(
            cgroup_members(
                &CgroupScope {
                    path: "/scope".to_string(),
                    dir: root.path().join("scope"),
                },
                42,
                super::super::MAX_PROCESSES,
                super::super::MAX_DEPTH,
            ),
            Err("cgroup_pane_pid_missing")
        );
    }

    #[test]
    fn a_scope_that_contains_the_agent_is_shared() {
        let root = tempfile::tempdir().unwrap();
        let agent = std::process::id();
        write(
            &root.path().join("scope/cgroup.procs"),
            &format!("42\n{agent}\n"),
        );
        assert_eq!(
            cgroup_members(
                &CgroupScope {
                    path: "/scope".to_string(),
                    dir: root.path().join("scope"),
                },
                42,
                super::super::MAX_PROCESSES,
                super::super::MAX_DEPTH,
            ),
            Err("shared_cgroup")
        );
    }

    #[test]
    fn stat_parsing_survives_a_command_name_with_spaces_and_parentheses() {
        let root = tempfile::tempdir().unwrap();
        let stat = root.path().join("stat");
        fs::write(
            &stat,
            "42 (a (weird) name) S 1 42 42 34816 42 4194304 0 0 0 0 10 5 0 0 20 0 3 0 1000 12345 7 0 0\n",
        )
        .unwrap();
        let parsed = read_stat(&stat).unwrap();
        assert_eq!(parsed.ppid, 1);
        assert_eq!(parsed.pgid, 42);
        assert_eq!(parsed.sid, 42);
        assert_eq!(parsed.utime_ticks, 10);
        assert_eq!(parsed.stime_ticks, 5);
        assert_eq!(parsed.threads, 3);
        assert_eq!(parsed.start_ticks, 1000);
        assert_eq!(parsed.rss_pages, 7);
    }

    #[test]
    fn a_pty_tty_is_named_the_way_a_user_reads_it() {
        assert_eq!(tty_name((136 << 8) | 12), Some("/dev/pts/12".to_string()));
        assert_eq!(tty_name(0), None);
    }
}
