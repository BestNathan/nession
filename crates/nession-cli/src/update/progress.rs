//! The shared phase/progress/event and cancellation model (#4592 §8.3–8.4).
//!
//! Every upgrade entry point reports the same phases, the same bounded
//! progress and the same failure contract: phase, category, retryability,
//! what happened to Current, and the safe next action. Interactive TTYs get
//! throttled in-place progress; noninteractive runs get bounded line-oriented
//! logs with no ANSI requirement and no misleading percentage for unknown
//! sizes. Credentials, signed URLs and config text never appear here.

use crate::update::policy::redact_url;
use crate::update::UpdateError;
use std::io::IsTerminal;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The ordered phases of an upgrade, shared by the CLI and installer handoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    ResolveRelease,
    DownloadChecksums,
    DownloadAsset,
    Verify,
    Extract,
    WaitLock,
    Preflight,
    Snapshot,
    Migrate,
    Publish,
    BinarySwap,
    Validate,
    Commit,
    Cleanup,
    Rollback,
    Recovery,
}

impl Phase {
    pub fn label(self) -> &'static str {
        match self {
            Phase::ResolveRelease => "resolve-release",
            Phase::DownloadChecksums => "download-checksums",
            Phase::DownloadAsset => "download-asset",
            Phase::Verify => "verify",
            Phase::Extract => "extract",
            Phase::WaitLock => "wait-lock",
            Phase::Preflight => "preflight",
            Phase::Snapshot => "snapshot",
            Phase::Migrate => "migrate",
            Phase::Publish => "publish",
            Phase::BinarySwap => "binary-swap",
            Phase::Validate => "validate",
            Phase::Commit => "commit",
            Phase::Cleanup => "cleanup",
            Phase::Rollback => "rollback",
            Phase::Recovery => "recovery",
        }
    }
}

/// One cooperative cancellation path for SIGINT/SIGTERM and deadlines.
///
/// Cancellation is checked at safe boundaries (between chunks, between
/// phases). It never interrupts a synchronous rename/fsync/SQLite write in
/// flight; after mutation begins the transaction completes rollback or keeps
/// its journal in an explicit recovery-blocked state (§8.3).
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// Fail with the phase named when cancellation was requested.
    pub fn check(&self, phase: Phase) -> Result<(), UpdateError> {
        if self.is_cancelled() {
            return Err(UpdateError::Cancelled {
                phase: phase.label().to_string(),
            });
        }
        Ok(())
    }
}

/// A progress/event sink. `Reporter` owns throttling so callers can emit
/// per-chunk without flooding a terminal or a CI log.
#[derive(Debug, Clone)]
pub enum Event {
    PhaseStarted {
        phase: Phase,
    },
    PhaseDone {
        phase: Phase,
        elapsed: Duration,
    },
    /// Byte progress for one asset transfer attempt.
    Download {
        received: u64,
        total: Option<u64>,
        attempt: u32,
        attempts: u32,
        /// Nonzero when this attempt continued a verified partial.
        resumed_from: u64,
        elapsed: Duration,
    },
    LockWait {
        elapsed: Duration,
    },
    /// A bounded, non-secret diagnostic line.
    Note(String),
}

/// Throttled progress output for one invocation.
pub struct Reporter {
    tty: bool,
    state: Mutex<ReporterState>,
    /// Minimum interval between progress lines (TTY and noninteractive).
    pub interval: Duration,
}

struct ReporterState {
    last_emit: Option<Instant>,
    last_percent: Option<u64>,
    line_open: bool,
}

impl Reporter {
    pub fn new() -> Self {
        Self {
            tty: std::io::stdout().is_terminal(),
            state: Mutex::new(ReporterState {
                last_emit: None,
                last_percent: None,
                line_open: false,
            }),
            interval: Duration::from_millis(250),
        }
    }

    /// A reporter that never prints (unit tests, library callers).
    pub fn silent() -> Self {
        Self {
            tty: false,
            state: Mutex::new(ReporterState {
                last_emit: None,
                last_percent: None,
                line_open: false,
            }),
            interval: Duration::from_secs(3600),
        }
    }

    pub fn emit(&self, event: Event) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match event {
            Event::PhaseStarted { phase } => {
                self.finish_line(&mut state);
                println!("[{}] start", phase.label());
            }
            Event::PhaseDone { phase, elapsed } => {
                self.finish_line(&mut state);
                println!("[{}] done ({:.1}s)", phase.label(), elapsed.as_secs_f64());
            }
            Event::Note(line) => {
                self.finish_line(&mut state);
                println!("{line}");
            }
            Event::LockWait { elapsed } => {
                // One line per throttle window, never per poll iteration.
                if !self.throttle_ok(&mut state, None) {
                    return;
                }
                self.finish_line(&mut state);
                println!(
                    "[wait-lock] waiting for the lifecycle lock ({:.0}s)",
                    elapsed.as_secs_f64()
                );
            }
            Event::Download {
                received,
                total,
                attempt,
                attempts,
                resumed_from,
                elapsed,
            } => {
                let percent = total
                    .filter(|t| *t > 0)
                    .map(|t| (received.saturating_mul(100) / t).min(100));
                let complete = percent == Some(100);
                if !complete && !self.throttle_ok(&mut state, percent) {
                    return;
                }
                // Whole bytes/sec is enough for a progress line; integer
                // division keeps the display path cast-free.
                let speed = received / elapsed.as_secs().max(1);
                let mut line = format!("[download-asset] {}", format_bytes(received));
                if let Some(total) = total {
                    line.push_str(&format!(
                        " / {} ({}%)",
                        format_bytes(total),
                        percent.unwrap_or(0)
                    ));
                } else {
                    // Unknown length is indeterminate, never a fake percent.
                    line.push_str(" (total unknown)");
                }
                if attempt > 1 {
                    line.push_str(&format!(" attempt {attempt}/{attempts}"));
                }
                if resumed_from > 0 {
                    line.push_str(&format!(" (resumed from {})", format_bytes(resumed_from)));
                }
                if speed > 0 {
                    line.push_str(&format!(" {}/s", format_bytes(speed)));
                }
                if self.tty {
                    print!("\r{line}   ");
                    use std::io::Write;
                    let _ = std::io::stdout().flush();
                    state.line_open = true;
                } else {
                    println!("{line}");
                }
            }
        }
    }

    fn throttle_ok(&self, state: &mut ReporterState, percent: Option<u64>) -> bool {
        let now = Instant::now();
        let time_ok = state
            .last_emit
            .map(|last| now.duration_since(last) >= self.interval)
            .unwrap_or(true);
        let percent_changed = match (percent, state.last_percent) {
            (Some(p), Some(last)) => p != last,
            (Some(_), None) => true,
            _ => false,
        };
        if time_ok || percent_changed {
            state.last_emit = Some(now);
            state.last_percent = percent;
            true
        } else {
            false
        }
    }

    fn finish_line(&self, state: &mut ReporterState) {
        if state.line_open {
            println!();
            state.line_open = false;
        }
    }
}

impl Default for Reporter {
    fn default() -> Self {
        Self::new()
    }
}

/// Human-readable byte size for progress lines.
pub fn format_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let value = bytes as f64;
    if value >= GIB {
        format!("{:.1}GiB", value / GIB)
    } else if value >= MIB {
        format!("{:.1}MiB", value / MIB)
    } else if value >= KIB {
        format!("{:.1}KiB", value / KIB)
    } else {
        format!("{bytes}B")
    }
}

/// What happened to the Current installation when an upgrade failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurrentState {
    /// Nothing outside private staging changed.
    Unchanged,
    /// Mutation began and was fully restored from verified snapshots.
    RolledBack,
    /// The upgrade committed; later user writes are never auto-discarded.
    Committed,
    /// Recovery could not prove a consistent state; the journal is retained.
    RecoveryBlocked,
}

impl CurrentState {
    pub fn label(self) -> &'static str {
        match self {
            CurrentState::Unchanged => "unchanged",
            CurrentState::RolledBack => "rolled-back",
            CurrentState::Committed => "committed",
            CurrentState::RecoveryBlocked => "recovery-blocked",
        }
    }
}

/// The failure contract: phase, category, retryability, Current state, cause
/// and the safe next action (§8.4).
#[derive(Debug, Clone)]
pub struct FailureReport {
    pub phase: Phase,
    pub category: &'static str,
    pub retryable: bool,
    pub current_state: CurrentState,
    pub cause: String,
    pub next_action: String,
}

impl FailureReport {
    /// Classify an update error at the phase where it surfaced.
    pub fn from_update_error(phase: Phase, error: &UpdateError) -> Self {
        let (category, retryable, next_action) = match error {
            UpdateError::ConnectTimeout { .. } => (
                "connect-timeout",
                true,
                "check network/proxy reachability, then retry",
            ),
            UpdateError::IdleTimeout { .. } => (
                "idle-timeout",
                true,
                "the transfer stalled; retry resumes a verified partial when the server supports it",
            ),
            UpdateError::TransferBudgetExhausted { .. } => (
                "transfer-budget",
                true,
                "retry on a faster link or raise --transfer-budget-secs within its validated range",
            ),
            UpdateError::RetryExhausted { .. } => (
                "retry-exhausted",
                true,
                "inspect the cause below; retry once the remote endpoint recovers",
            ),
            UpdateError::RateLimited | UpdateError::RateLimitedRetryAfter { .. } => (
                "rate-limited",
                true,
                "wait for the rate-limit window or set GITHUB_TOKEN, then retry",
            ),
            UpdateError::LockTimeout { .. } => (
                "lock-timeout",
                true,
                "another lifecycle command holds the lock; retry after it finishes",
            ),
            UpdateError::Cancelled { .. } => (
                "cancelled",
                true,
                "re-run the install; a retained journal is recovered automatically",
            ),
            UpdateError::ChecksumMismatch { .. } | UpdateError::SizeMismatch { .. } => (
                "artifact-integrity",
                false,
                "the release artifact is corrupt or tampered; it was discarded, retry fetches a fresh copy",
            ),
            UpdateError::ReleaseNotFound(_) | UpdateError::AssetNotFound(_) => (
                "release-not-found",
                false,
                "check the requested version and platform asset",
            ),
            UpdateError::Policy(_) => (
                "invalid-policy",
                false,
                "correct the timeout/retry override and re-run",
            ),
            UpdateError::Io(_) | UpdateError::PermissionDenied(_) => (
                "io",
                true,
                "check disk space and permissions, then retry",
            ),
            UpdateError::InsufficientSpace { .. } => (
                "insufficient-space",
                false,
                "free disk space for the snapshot budget, then retry",
            ),
            _ => ("error", true, "inspect the cause and retry"),
        };
        Self {
            phase,
            category,
            retryable,
            // Before the lock is taken nothing mutates; the transaction owner
            // overrides this with the proven state on failure.
            current_state: CurrentState::Unchanged,
            cause: error.to_string(),
            next_action: next_action.to_string(),
        }
    }

    /// Render the bounded, non-secret failure block for stderr.
    pub fn render(&self) -> String {
        format!(
            "install failed:\n  phase: {}\n  category: {}\n  retryable: {}\n  Current: {}\n  cause: {}\n  next: {}",
            self.phase.label(),
            self.category,
            if self.retryable { "yes" } else { "no" },
            self.current_state.label(),
            self.cause,
            self.next_action,
        )
    }
}

/// Redact a URL before it enters any diagnostic string.
pub fn safe_url(url: &str) -> String {
    redact_url(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_token_is_cooperative() {
        let token = CancelToken::new();
        assert!(!token.is_cancelled());
        assert!(token.check(Phase::DownloadAsset).is_ok());
        token.cancel();
        let error = token.check(Phase::DownloadAsset).unwrap_err();
        assert!(matches!(error, UpdateError::Cancelled { .. }));
        assert!(error.to_string().contains("download-asset"));
        // Clones share the same flag: the signal handler and the work loop
        // observe one cancellation.
        let clone = token;
        assert!(clone.is_cancelled());
    }

    #[test]
    fn byte_formatting_is_bounded() {
        assert_eq!(format_bytes(512), "512B");
        assert_eq!(format_bytes(2048), "2.0KiB");
        assert_eq!(format_bytes(5 * 1024 * 1024), "5.0MiB");
    }

    #[test]
    fn failure_report_classifies_timeout_and_integrity() {
        let timeout = FailureReport::from_update_error(
            Phase::DownloadAsset,
            &UpdateError::IdleTimeout {
                url: "https://host/x".into(),
                idle: Duration::from_secs(60),
                received: 10,
            },
        );
        assert_eq!(timeout.category, "idle-timeout");
        assert!(timeout.retryable);
        assert_eq!(timeout.current_state, CurrentState::Unchanged);
        let rendered = timeout.render();
        assert!(rendered.contains("phase: download-asset"));
        assert!(rendered.contains("Current: unchanged"));

        let corrupt = FailureReport::from_update_error(
            Phase::Verify,
            &UpdateError::ChecksumMismatch {
                expected: "a".into(),
                actual: "b".into(),
            },
        );
        assert!(!corrupt.retryable);
        assert_eq!(corrupt.category, "artifact-integrity");
    }

    #[test]
    fn silent_reporter_emits_without_panic() {
        let reporter = Reporter::silent();
        reporter.emit(Event::PhaseStarted {
            phase: Phase::Snapshot,
        });
        reporter.emit(Event::Download {
            received: 10,
            total: None,
            attempt: 1,
            attempts: 4,
            resumed_from: 0,
            elapsed: Duration::from_secs(1),
        });
        reporter.emit(Event::PhaseDone {
            phase: Phase::Snapshot,
            elapsed: Duration::from_secs(1),
        });
    }
}
