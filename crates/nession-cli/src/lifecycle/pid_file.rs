//! PID file management utilities for daemon processes.
//!
//! Provides functions to create, read, and manage PID files for
//! background processes like agents and servers.

use anyhow::{Context, Result};
use nession_common::paths;
use std::fs;
use std::path::Path;

/// Write the current process ID to a file.
///
/// **Superseded by [`write_identity`]**, which records enough to answer whether
/// the process is still the one that wrote the file. Kept only for the one
/// reader that still parses a bare pid — see `read_pid_file` — because writing
/// one is now a way to lose that information.
///
/// Not a `pub` API any more: nothing writes a bare pid (#1016).
#[cfg(test)]
fn write_pid_file(path: &str, pid: u32) -> Result<()> {
    fs::write(path, pid.to_string())
        .with_context(|| format!("Failed to write PID file: {path}"))?;
    Ok(())
}

/// Read a PID from a file.
///
/// Returns the PID stored in the file at `path`.
/// Returns an error if the file doesn't exist or contains invalid data.
pub fn read_pid_file(path: &str) -> Result<u32> {
    let content =
        fs::read_to_string(path).with_context(|| format!("Failed to read PID file: {path}"))?;
    let pid: u32 = content
        .trim()
        .parse()
        .with_context(|| format!("Failed to parse PID from file: {path}"))?;
    Ok(pid)
}

/// Check if a process with the given PID is currently running.
///
/// Returns `true` if the process exists, `false` otherwise.
/// On Unix systems, this sends a signal 0 to check process existence.
#[cfg(unix)]
pub fn is_process_running(pid: u32) -> bool {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

    kill(Pid::from_raw(pid as i32), None).is_ok()
}

#[cfg(not(unix))]
pub fn is_process_running(pid: u32) -> bool {
    // On non-Unix systems, we can't easily check process existence
    // This is a placeholder implementation
    false
}

/// Check if a process is running based on its PID file.
///
/// Returns `true` if the PID file exists and the process is running.
/// Returns `false` if the file doesn't exist, is invalid, or the process is not running.
#[allow(dead_code)]
pub fn is_process_running_from_pid_file(path: &str) -> bool {
    if !Path::new(path).exists() {
        return false;
    }

    match read_pid_file(path) {
        Ok(pid) => is_process_running(pid),
        Err(_) => false,
    }
}

/// Format a duration in seconds into a human-readable string.
///
/// Examples:
/// - 30 seconds -> "30 seconds"
/// - 90 seconds -> "1 minute 30 seconds"
/// - 3661 seconds -> "1 hour 1 minute 1 second"
pub fn format_duration(seconds: u64) -> String {
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let secs = seconds % 60;

    let mut parts = Vec::new();

    if hours > 0 {
        parts.push(format!(
            "{} hour{}",
            hours,
            if hours == 1 { "" } else { "s" }
        ));
    }

    if minutes > 0 {
        parts.push(format!(
            "{} minute{}",
            minutes,
            if minutes == 1 { "" } else { "s" }
        ));
    }

    if secs > 0 || parts.is_empty() {
        parts.push(format!(
            "{} second{}",
            secs,
            if secs == 1 { "" } else { "s" }
        ));
    }

    parts.join(" ")
}

/// Which Nession component a state file belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Component {
    Agent,
    Server,
}

impl Component {
    pub fn as_str(self) -> &'static str {
        match self {
            Component::Agent => "agent",
            Component::Server => "server",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "agent" => Some(Component::Agent),
            "server" => Some(Component::Server),
            _ => None,
        }
    }
}

/// The state-file locations a component's live process may be found at.
///
/// The runtime-directory file is authoritative. The legacy home-relative file
/// is consulted only when the operator did not pass `--pid-file`: a daemon
/// started by a pre-runtime binary must remain discoverable and manageable
/// without letting a bare legacy pid stand in for ownership evidence.
#[derive(Debug, Clone)]
pub struct StateFiles {
    /// The state file this invocation reads and writes.
    pub current: String,
    /// The pre-runtime-directory location, present only for default state
    /// files. `None` for an explicit `--pid-file`, which stays authoritative
    /// and is never migrated implicitly.
    pub legacy: Option<String>,
}

impl StateFiles {
    /// An operator-supplied `--pid-file`. It is the highest-priority override;
    /// no legacy location is consulted.
    pub fn explicit(path: String) -> Self {
        Self {
            current: path,
            legacy: None,
        }
    }

    /// Resolve the default runtime directory state file for `component`.
    ///
    /// Fails rather than falling back to `./agent.pid` / `./server.pid` or to a
    /// durable home directory when the runtime root cannot be resolved.
    pub fn from_cli(explicit: Option<String>, component: Component) -> Result<Self> {
        if let Some(path) = explicit {
            return Ok(Self::explicit(path));
        }

        let runtime_dir = paths::ensure_runtime_dir().with_context(|| {
            format!(
                "cannot resolve the default {} state file; set {} to an absolute, user-owned \
                 directory or pass --pid-file",
                component.as_str(),
                paths::NESSION_RUNTIME_DIR_ENV
            )
        })?;
        let (current, legacy) = match component {
            Component::Agent => (paths::agent_pid_path(), paths::legacy_agent_pid_path()),
            Component::Server => (paths::server_pid_path(), paths::legacy_server_pid_path()),
        };
        let current = current.with_context(|| {
            format!(
                "cannot resolve the default {} state file under {}",
                component.as_str(),
                runtime_dir.display()
            )
        })?;
        let legacy = legacy.ok().map(|path| path.to_string_lossy().into_owned());
        Ok(Self {
            current: current.to_string_lossy().into_owned(),
            legacy,
        })
    }

    /// Whether this invocation uses the default runtime-directory location
    /// (and therefore also watches the legacy location).
    pub fn is_default_location(&self) -> bool {
        self.legacy.is_some()
    }
}

/// What a daemon state file records about the configuration it is running.
///
/// The process itself writes this, so `status` can distinguish "this file was
/// loaded" from "the documented defaults are in effect" without reading a
/// default file that may not have been loaded (#2869 SC-04).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigRecord {
    /// The selected config file was read at startup.
    File(String),
    /// No config file existed at the implicit default path; built-in defaults
    /// are in effect.
    Defaults,
    /// The record predates this field, or the process did not write one. The
    /// CLI cannot claim which configuration is live.
    Unknown,
}

impl ConfigRecord {
    /// Record the source the loader actually used.
    pub fn from_loaded(path: &Path, from_file: bool) -> Self {
        if from_file {
            ConfigRecord::File(path.to_string_lossy().into_owned())
        } else {
            ConfigRecord::Defaults
        }
    }
}

/// What a daemon state file records about the process that wrote it.
///
/// A bare pid is **not** an identity (#1016): operating systems reuse PIDs, so
/// "a process with this number exists" does not mean "the Nession process this
/// file was written for is alive" — and `stop` acting on that reading can signal
/// an unrelated process. The start time is what closes the gap: a reused pid
/// names a *different* instance, and two instances disagree about when they
/// started.
///
/// There is deliberately no instance nonce. The issue sketches one, but nothing
/// can *verify* a nonce — it could only be recorded, which proves no more than
/// the start time already does. A field that looks like evidence and isn't is
/// worse than not having it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    /// When the process started, in seconds since the Unix epoch.
    pub started_at: u64,
    pub kind: Component,
    /// The configuration the process is actually running, recorded by the
    /// process itself. `Unknown` means it started without recording one (or
    /// predates the record); `status` must then say the source is unknown
    /// instead of presenting a default file as live state.
    pub config_source: ConfigRecord,
}

impl ProcessIdentity {
    /// The identity of the process calling this.
    pub fn of_current_process(kind: Component) -> Result<Self> {
        let pid = std::process::id();
        let started_at = start_time_of(pid).with_context(|| {
            format!("cannot determine when pid {pid} started; refusing to record an identity")
        })?;
        Ok(Self {
            pid,
            started_at,
            kind,
            config_source: ConfigRecord::Unknown,
        })
    }
}

/// How far two readings of the same start time may differ and still be the same
/// instance.
///
/// Both readings are derived from `now` and a second-resolution uptime, so the
/// same process can measure a second apart on two calls. A pid reused by a
/// process that started within this window of its predecessor would compare
/// equal — which is a far narrower hole than "the pid exists", and not one this
/// can close without a platform-specific clock.
const START_TIME_TOLERANCE_SECS: u64 = 2;

/// When `pid` started, approximately, as seconds since the Unix epoch.
///
/// `now` minus the process's own uptime — deliberately one primitive rather than
/// two. The obvious composition, `boot_time + uptime`, is only correct where
/// `get_boot_time` measures: on Linux it does, and everywhere else it returns
/// `now - 3600` as a placeholder, which would make the sum drift by two seconds
/// per second instead of standing still.
///
/// What this needs from the result is *stability*, not accuracy: two readings of
/// an unchanged process must agree, and two different instances must not. Hence
/// the tolerance at the call site.
fn start_time_of(pid: u32) -> Option<u64> {
    let uptime = super::process::get_process_uptime(pid)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(now.saturating_sub(uptime))
}

/// Record the identity of the current process at `path`.
pub fn write_identity(
    path: &str,
    kind: Component,
    config_source: ConfigRecord,
) -> Result<ProcessIdentity> {
    let mut identity = ProcessIdentity::of_current_process(kind)?;
    let config_lines = match &config_source {
        ConfigRecord::File(config_path) => {
            if config_path.contains(['\n', '\r']) {
                anyhow::bail!("refusing to record a config path containing a newline");
            }
            format!("config_source=file\nconfig_path={config_path}\n")
        }
        ConfigRecord::Defaults => "config_source=defaults\n".to_string(),
        ConfigRecord::Unknown => String::new(),
    };
    identity.config_source = config_source;
    let body = format!(
        "pid={}\nstarted_at={}\nkind={}\n{}",
        identity.pid,
        identity.started_at,
        identity.kind.as_str(),
        config_lines
    );
    fs::write(path, body).with_context(|| format!("Failed to write state file: {path}"))?;
    Ok(identity)
}

/// Read the identity recorded at `path`.
pub fn read_identity(path: &str) -> Result<ProcessIdentity> {
    let content =
        fs::read_to_string(path).with_context(|| format!("Failed to read state file: {path}"))?;

    let mut pid = None;
    let mut started_at = None;
    let mut kind = None;
    let mut source_kind = None;
    let mut config_path = None;
    for line in content.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "pid" => pid = value.trim().parse::<u32>().ok(),
            "started_at" => started_at = value.trim().parse::<u64>().ok(),
            "kind" => kind = Component::parse(value.trim()),
            "config_source" => source_kind = Some(value.trim().to_string()),
            "config_path" => config_path = Some(value.trim().to_string()),
            _ => {}
        }
    }

    // A legacy `config_path=` line without the source marker is not evidence:
    // the old writer recorded the *selected* path even when it did not exist
    // and defaults were used, which is exactly the ambiguity #2869 fixes.
    let config_source = match source_kind.as_deref() {
        Some("file") => config_path
            .map(ConfigRecord::File)
            .unwrap_or(ConfigRecord::Unknown),
        Some("defaults") => ConfigRecord::Defaults,
        _ => ConfigRecord::Unknown,
    };

    match (pid, started_at, kind) {
        (Some(pid), Some(started_at), Some(kind)) => Ok(ProcessIdentity {
            pid,
            started_at,
            kind,
            config_source,
        }),
        // A file the old format wrote — a bare pid — reads as a missing record
        // rather than as an identity, because a bare pid is what this replaces.
        _ => anyhow::bail!("state file at {path} does not hold a process identity"),
    }
}

/// What the state file at `path` says about the process it names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ownership {
    /// The recorded instance is running: safe to signal.
    Alive(ProcessIdentity),
    /// The pid is alive but is a different instance — it was reused.
    Reused(ProcessIdentity),
    /// Nothing is running under that pid.
    Stale(ProcessIdentity),
}

/// Decide whether the process a state file names is the one that wrote it.
pub fn ownership(path: &str) -> Result<Ownership> {
    let recorded = read_identity(path)?;
    if !is_process_running(recorded.pid) {
        return Ok(Ownership::Stale(recorded));
    }
    match start_time_of(recorded.pid) {
        Some(started) if started.abs_diff(recorded.started_at) <= START_TIME_TOLERANCE_SECS => {
            Ok(Ownership::Alive(recorded))
        }
        // Either the start time differs — the pid is somebody else's process now
        // — or it could not be read at all. Both fall to the same answer on
        // purpose: `stop` must not signal a process whose ownership it cannot
        // establish (#1016), and "I cannot tell" is not "it is mine".
        _ => Ok(Ownership::Reused(recorded)),
    }
}

/// Which location a record was read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// The runtime-directory state file this invocation owns.
    Runtime,
    /// The pre-runtime home-relative file, read for migration only.
    Legacy,
}

/// What a state file location says about the process it names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordState {
    /// No file at this location.
    Missing,
    /// The recorded instance is running: safe to signal.
    Alive(ProcessIdentity),
    /// The pid is alive but is a different instance — it was reused.
    Reused(ProcessIdentity),
    /// Nothing is running under that pid.
    Stale(ProcessIdentity),
    /// A file exists but does not hold a verifiable process identity (a bare
    /// pid, a corrupt record, or an unreadable file).
    Unprovable,
}

/// One inspected state-file location.
#[derive(Debug, Clone)]
pub struct StateRecord {
    pub origin: Origin,
    pub path: String,
    pub state: RecordState,
}

/// All state-file locations consulted for one command.
#[derive(Debug, Clone)]
pub struct Inspection {
    pub records: Vec<StateRecord>,
}

impl Inspection {
    /// Inspect the runtime location first, then the optional legacy location.
    pub fn of(files: &StateFiles) -> Self {
        let mut records = vec![inspect_record(&files.current, Origin::Runtime)];
        if let Some(legacy) = files.legacy.as_deref() {
            records.push(inspect_record(legacy, Origin::Legacy));
        }
        Self { records }
    }

    /// Every verified live process, runtime location first.
    pub fn live_records(&self) -> Vec<(&StateRecord, ProcessIdentity)> {
        self.records
            .iter()
            .filter_map(|record| match &record.state {
                RecordState::Alive(identity) => Some((record, identity.clone())),
                _ => None,
            })
            .collect()
    }

    /// The verified live process to report, if any.
    pub fn live(&self) -> Option<(&StateRecord, ProcessIdentity)> {
        self.live_records().into_iter().next()
    }

    /// Remove state records that provably do not name a live process.
    ///
    /// The runtime-directory record is always removed when it is not alive —
    /// it is this process's own state and a dead record must not make the next
    /// start believe otherwise. The legacy record is removed only when stale;
    /// a reused or unprovable legacy record is migration evidence that a reader
    /// unable to establish ownership must not discard.
    pub fn clean_dead(&self) {
        for record in &self.records {
            let remove = match (&record.state, record.origin) {
                (RecordState::Alive(_) | RecordState::Missing, _) => false,
                (RecordState::Stale(_), _) => true,
                (RecordState::Reused(_) | RecordState::Unprovable, Origin::Runtime) => true,
                (RecordState::Reused(_) | RecordState::Unprovable, Origin::Legacy) => false,
            };
            if remove {
                let _ = fs::remove_file(&record.path);
            }
        }
    }

    /// Diagnostics for records left in place because ownership could not be
    /// established there: a reused pid or an unprovable legacy record.
    pub fn unresolved_warnings(&self, component: &str) -> Vec<String> {
        self.records
            .iter()
            .filter_map(|record| match (&record.state, record.origin) {
                (RecordState::Reused(identity), _) => Some(format!(
                    "the recorded pid {} at {} is running but is not this {component}; \
                     not signalling it",
                    identity.pid, record.path
                )),
                (RecordState::Unprovable, Origin::Legacy) => Some(format!(
                    "legacy state at {} is not a verifiable {component} identity; \
                     not treating it as running",
                    record.path
                )),
                _ => None,
            })
            .collect()
    }
}

/// Human report for a location that does not name a live process.
pub fn report_not_live(record: &StateRecord, component: &str) {
    match &record.state {
        RecordState::Missing => {
            if record.origin == Origin::Runtime {
                println!("{component} is not running (no state file found)");
            }
        }
        RecordState::Stale(identity) => {
            println!("{component} process {} is not running", identity.pid);
        }
        RecordState::Reused(identity) => {
            println!(
                "Recorded pid {} at {} is running but is not this {component} — not signalling it.",
                identity.pid, record.path
            );
        }
        RecordState::Unprovable => {
            println!(
                "State file {} does not hold a verifiable {component} identity — \
                 not signalling any process.",
                record.path
            );
        }
        RecordState::Alive(_) => {}
    }
}

/// Human report for a location that does not name a live process, in `status`
/// wording.
pub fn report_not_live_status(record: &StateRecord, component: &str) {
    match &record.state {
        RecordState::Missing => {
            if record.origin == Origin::Runtime {
                println!("Status: stopped (no state file)");
            }
        }
        RecordState::Stale(_) => {
            println!("Status: stopped (process not running)");
        }
        RecordState::Reused(identity) => {
            println!(
                "Status: stopped (pid {} at {} is running but is not this {component})",
                identity.pid, record.path
            );
        }
        RecordState::Unprovable => {
            println!(
                "Status: stopped (state file {} is not a verifiable {component} identity)",
                record.path
            );
        }
        RecordState::Alive(_) => {}
    }
}

fn inspect_record(path: &str, origin: Origin) -> StateRecord {
    let state = match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => RecordState::Missing,
        // A file that exists but cannot be read is not evidence either way.
        Err(_) => RecordState::Unprovable,
        Ok(_) => match ownership(path) {
            Ok(Ownership::Alive(identity)) => RecordState::Alive(identity),
            Ok(Ownership::Reused(identity)) => RecordState::Reused(identity),
            Ok(Ownership::Stale(identity)) => RecordState::Stale(identity),
            Err(_) => RecordState::Unprovable,
        },
    };
    StateRecord {
        origin,
        path: path.to_string(),
        state,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_write_and_read_pid_file() {
        let temp_dir = TempDir::new().unwrap();
        let pid_file = temp_dir.path().join("test.pid");
        let pid_file_str = pid_file.to_str().unwrap();

        let test_pid = 12345u32;
        write_pid_file(pid_file_str, test_pid).unwrap();

        let read_pid = read_pid_file(pid_file_str).unwrap();
        assert_eq!(read_pid, test_pid);
    }

    #[test]
    fn test_read_nonexistent_pid_file() {
        let result = read_pid_file("/nonexistent/path/to/pid.file");
        assert!(result.is_err());
    }

    #[test]
    fn test_format_duration_seconds() {
        assert_eq!(format_duration(30), "30 seconds");
        assert_eq!(format_duration(1), "1 second");
        assert_eq!(format_duration(0), "0 seconds");
    }

    #[test]
    fn test_format_duration_minutes() {
        assert_eq!(format_duration(90), "1 minute 30 seconds");
        assert_eq!(format_duration(60), "1 minute");
        assert_eq!(format_duration(120), "2 minutes");
    }

    #[test]
    fn test_format_duration_hours() {
        assert_eq!(format_duration(3661), "1 hour 1 minute 1 second");
        assert_eq!(format_duration(3600), "1 hour");
        assert_eq!(format_duration(7200), "2 hours");
    }

    #[test]
    fn test_is_process_running_current_process() {
        // Current process should be running
        let current_pid = std::process::id();
        assert!(is_process_running(current_pid));
    }

    #[test]
    fn test_is_process_running_nonexistent() {
        // Very high PID that likely doesn't exist
        assert!(!is_process_running(999999999));
    }

    #[test]
    fn test_is_process_running_from_pid_file() {
        let temp_dir = TempDir::new().unwrap();
        let pid_file = temp_dir.path().join("test.pid");
        let pid_file_str = pid_file.to_str().unwrap();

        // Non-existent file
        assert!(!is_process_running_from_pid_file(pid_file_str));

        // Current process
        let current_pid = std::process::id();
        write_pid_file(pid_file_str, current_pid).unwrap();
        assert!(is_process_running_from_pid_file(pid_file_str));

        // Non-existent process
        write_pid_file(pid_file_str, 999999999).unwrap();
        assert!(!is_process_running_from_pid_file(pid_file_str));
    }

    /// A record naming some other pid, written without going through
    /// `write_identity` — which can only ever describe the calling process.
    fn record(path: &str, pid: u32, started_at: u64) {
        std::fs::write(
            path,
            format!("pid={pid}\nstarted_at={started_at}\nkind=agent\n"),
        )
        .unwrap();
    }

    #[test]
    fn an_identity_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("agent.pid");
        let path = path.to_str().unwrap();

        let written = write_identity(path, Component::Agent, ConfigRecord::Unknown).unwrap();
        let read = read_identity(path).unwrap();

        assert_eq!(read, written);
        assert_eq!(read.pid, std::process::id());
        assert_eq!(read.kind, Component::Agent);
    }

    #[test]
    fn an_identity_records_the_config_file_the_process_loaded() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("agent.pid");
        let path = path.to_str().unwrap();

        write_identity(
            path,
            Component::Agent,
            ConfigRecord::File("/custom/agent.toml".to_string()),
        )
        .unwrap();
        let read = read_identity(path).unwrap();

        assert_eq!(
            read.config_source,
            ConfigRecord::File("/custom/agent.toml".to_string())
        );
    }

    /// A daemon started from the documented defaults records that fact, so
    /// `status` does not call the absent default file a loaded source.
    #[test]
    fn an_identity_can_record_built_in_defaults() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("agent.pid");
        let path = path.to_str().unwrap();

        write_identity(path, Component::Agent, ConfigRecord::Defaults).unwrap();

        assert_eq!(
            read_identity(path).unwrap().config_source,
            ConfigRecord::Defaults
        );
    }

    /// The old writer recorded `config_path` even when the file did not exist
    /// and defaults were used, so a legacy line is not evidence of a loaded
    /// file; it must read as unknown (#2869 SC-04).
    #[test]
    fn a_legacy_config_path_without_a_source_is_unknown() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("agent.pid");
        let path = path.to_str().unwrap();
        let current = ProcessIdentity::of_current_process(Component::Agent).unwrap();
        std::fs::write(
            path,
            format!(
                "pid={}\nstarted_at={}\nkind=agent\nconfig_path=/claimed/agent.toml\n",
                current.pid, current.started_at
            ),
        )
        .unwrap();

        assert_eq!(
            read_identity(path).unwrap().config_source,
            ConfigRecord::Unknown
        );
    }

    #[test]
    fn the_current_process_is_recognised_as_ours() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("agent.pid");
        let path = path.to_str().unwrap();

        write_identity(path, Component::Agent, ConfigRecord::Unknown).unwrap();

        assert!(matches!(ownership(path).unwrap(), Ownership::Alive(_)));
    }

    #[test]
    fn a_pid_that_is_not_running_is_stale() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("agent.pid");
        let path = path.to_str().unwrap();

        record(path, 999_999_999, 1_700_000_000);

        assert!(matches!(ownership(path).unwrap(), Ownership::Stale(_)));
    }

    /// The case this exists for: the pid is alive, but it is not our process.
    ///
    /// Written deterministically by naming *this* process's pid with a start
    /// time it cannot have — which is exactly what a reused pid looks like from
    /// the outside, without having to wait for the OS to recycle one.
    #[test]
    fn a_reused_pid_is_not_mistaken_for_ours() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("agent.pid");
        let path = path.to_str().unwrap();

        let real = ProcessIdentity::of_current_process(Component::Agent).unwrap();
        // Well outside the tolerance: this pid belongs to a process that started
        // a minute away from the one the file describes.
        record(path, real.pid, real.started_at + 60);

        let verdict = ownership(path).unwrap();
        assert!(
            matches!(verdict, Ownership::Reused(_)),
            "an alive pid with the wrong start time must not read as ours: {verdict:?}"
        );
    }

    /// The old format is not an identity, and must not be read as one.
    #[test]
    fn a_bare_pid_is_not_an_identity() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("agent.pid");
        let path = path.to_str().unwrap();

        std::fs::write(path, std::process::id().to_string()).unwrap();

        assert!(
            read_identity(path).is_err(),
            "a bare pid carries no ownership evidence and must not resolve"
        );
    }

    // --- Runtime/legacy location inspection (migration) ---

    fn two_locations(dir: &TempDir) -> StateFiles {
        StateFiles {
            current: dir
                .path()
                .join("runtime")
                .join("agent.pid")
                .to_string_lossy()
                .into_owned(),
            legacy: Some(
                dir.path()
                    .join("home")
                    .join("agent.pid")
                    .to_string_lossy()
                    .into_owned(),
            ),
        }
    }

    fn write_identity_at(path: &str) {
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        write_identity(path, Component::Agent, ConfigRecord::Unknown).unwrap();
    }

    #[test]
    fn an_explicit_state_file_has_no_legacy_location() {
        let files = StateFiles::explicit("/tmp/custom.pid".to_string());
        assert!(!files.is_default_location());
        assert_eq!(files.legacy, None);
    }

    #[test]
    fn a_live_legacy_daemon_is_discovered_when_the_runtime_file_is_absent() {
        let dir = TempDir::new().unwrap();
        let files = two_locations(&dir);
        write_identity_at(files.legacy.as_deref().unwrap());

        let inspection = Inspection::of(&files);
        let (record, identity) = inspection.live().expect("the legacy daemon is live");

        assert_eq!(record.origin, Origin::Legacy);
        assert_eq!(identity.pid, std::process::id());
    }

    #[test]
    fn runtime_state_wins_when_both_locations_record_a_live_process() {
        let dir = TempDir::new().unwrap();
        let files = two_locations(&dir);
        write_identity_at(&files.current);
        write_identity_at(files.legacy.as_deref().unwrap());

        let inspection = Inspection::of(&files);
        let (record, _) = inspection.live().expect("a live process");

        assert_eq!(record.origin, Origin::Runtime);
    }

    #[test]
    fn a_stale_legacy_record_is_not_live() {
        let dir = TempDir::new().unwrap();
        let files = two_locations(&dir);
        let legacy = files.legacy.as_deref().unwrap();
        std::fs::create_dir_all(std::path::Path::new(legacy).parent().unwrap()).unwrap();
        record(legacy, 999_999_999, 1_700_000_000);

        let state = Inspection::of(&files).records[1].state.clone();

        assert!(matches!(state, RecordState::Stale(_)), "{state:?}");
    }

    #[test]
    fn a_reused_legacy_pid_is_not_live() {
        let dir = TempDir::new().unwrap();
        let files = two_locations(&dir);
        let legacy = files.legacy.as_deref().unwrap();
        std::fs::create_dir_all(std::path::Path::new(legacy).parent().unwrap()).unwrap();
        let real = ProcessIdentity::of_current_process(Component::Agent).unwrap();
        record(legacy, real.pid, real.started_at + 60);

        let state = Inspection::of(&files).records[1].state.clone();

        assert!(matches!(state, RecordState::Reused(_)), "{state:?}");
    }

    #[test]
    fn an_unprovable_legacy_record_is_not_live() {
        let dir = TempDir::new().unwrap();
        let files = two_locations(&dir);
        let legacy = files.legacy.as_deref().unwrap();
        std::fs::create_dir_all(std::path::Path::new(legacy).parent().unwrap()).unwrap();
        std::fs::write(legacy, std::process::id().to_string()).unwrap();

        let inspection = Inspection::of(&files);

        assert_eq!(inspection.records[1].state, RecordState::Unprovable);
        assert!(inspection.live().is_none());
    }
}
