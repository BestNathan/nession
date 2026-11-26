//! The canonical phase-specific upgrade/transfer policy (#4592 §8).
//!
//! One owner resolves the timeouts, retry budget and lock wait for every
//! upgrade entry point (`nession install`, `nession update`, the
//! `scripts/install.sh` handoff). There is deliberately **no single global
//! HTTP timeout**: metadata lookups, asset transfer, the lifecycle-lock wait
//! and local transaction work each have their own bounded budget, because a
//! 10s whole-request budget kills a healthy multi-minute download while doing
//! nothing to bound a stalled one.
//!
//! Defaults are bounded; explicit CLI flags override environment overrides,
//! which override the defaults. Every override is range-validated so a typo
//! cannot produce an unbounded (or zero-length) budget. Tests use short
//! deterministic durations through the same validated path.

use crate::update::UpdateError;
use std::time::{Duration, Instant};

/// Default DNS/TCP/TLS connection budget.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Default per-request budget for metadata/release/checksum/contract probes.
pub const DEFAULT_METADATA_TIMEOUT: Duration = Duration::from_secs(30);
/// Default no-progress budget for an asset transfer (reset on received bytes).
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Default total transfer budget, including every retry.
pub const DEFAULT_TRANSFER_BUDGET: Duration = Duration::from_secs(30 * 60);
/// Default bounded lifecycle-lock wait for an upgrade.
pub const DEFAULT_LOCK_WAIT: Duration = Duration::from_secs(30);
/// Initial attempt + at most 3 retries.
pub const DEFAULT_RETRIES: u32 = 3;
/// Exponential backoff base (doubled per attempt, jittered, capped).
pub const DEFAULT_BACKOFF_BASE: Duration = Duration::from_millis(500);
/// Backoff cap so a retry never sleeps past a useful fraction of the budget.
pub const DEFAULT_BACKOFF_MAX: Duration = Duration::from_secs(8);

/// The resolved, validated policy for one upgrade invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferPolicy {
    pub connect_timeout: Duration,
    pub metadata_timeout: Duration,
    pub idle_timeout: Duration,
    pub transfer_budget: Duration,
    pub lock_wait: Duration,
    /// Number of retries after the initial attempt (metadata and transfer).
    pub retries: u32,
    pub backoff_base: Duration,
    pub backoff_max: Duration,
}

impl Default for TransferPolicy {
    fn default() -> Self {
        Self {
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            metadata_timeout: DEFAULT_METADATA_TIMEOUT,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            transfer_budget: DEFAULT_TRANSFER_BUDGET,
            lock_wait: DEFAULT_LOCK_WAIT,
            retries: DEFAULT_RETRIES,
            backoff_base: DEFAULT_BACKOFF_BASE,
            backoff_max: DEFAULT_BACKOFF_MAX,
        }
    }
}

impl TransferPolicy {
    /// Total attempts: the initial one plus the bounded retries.
    pub fn attempts(&self) -> u32 {
        self.retries.saturating_add(1)
    }
}

/// Explicit CLI overrides; `None` means "fall through to env/default".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PolicyOverrides {
    pub connect_timeout_secs: Option<u64>,
    pub metadata_timeout_secs: Option<u64>,
    pub idle_timeout_secs: Option<u64>,
    pub transfer_budget_secs: Option<u64>,
    pub lock_wait_secs: Option<u64>,
    pub retries: Option<u32>,
}

impl PolicyOverrides {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Environment override names. They are read only by [`resolve`]; the shell
/// bootstrap mirrors the same bounded semantics with curl/wget flags.
pub const CONNECT_TIMEOUT_ENV: &str = "NESSION_UPDATE_CONNECT_TIMEOUT_SECS";
pub const METADATA_TIMEOUT_ENV: &str = "NESSION_UPDATE_METADATA_TIMEOUT_SECS";
pub const IDLE_TIMEOUT_ENV: &str = "NESSION_UPDATE_IDLE_TIMEOUT_SECS";
pub const TRANSFER_BUDGET_ENV: &str = "NESSION_UPDATE_TRANSFER_BUDGET_SECS";
pub const LOCK_WAIT_ENV: &str = "NESSION_UPDATE_LOCK_WAIT_SECS";
pub const RETRIES_ENV: &str = "NESSION_UPDATE_RETRIES";
pub const BACKOFF_BASE_ENV: &str = "NESSION_UPDATE_BACKOFF_MS";

/// Resolve the policy: CLI override > validated env override > bounded default.
pub fn resolve(overrides: &PolicyOverrides) -> Result<TransferPolicy, UpdateError> {
    let mut policy = TransferPolicy {
        connect_timeout: Duration::from_secs(pick_secs(
            overrides.connect_timeout_secs,
            CONNECT_TIMEOUT_ENV,
            DEFAULT_CONNECT_TIMEOUT.as_secs(),
            1,
            120,
        )?),
        metadata_timeout: Duration::from_secs(pick_secs(
            overrides.metadata_timeout_secs,
            METADATA_TIMEOUT_ENV,
            DEFAULT_METADATA_TIMEOUT.as_secs(),
            1,
            300,
        )?),
        idle_timeout: Duration::from_secs(pick_secs(
            overrides.idle_timeout_secs,
            IDLE_TIMEOUT_ENV,
            DEFAULT_IDLE_TIMEOUT.as_secs(),
            1,
            600,
        )?),
        transfer_budget: Duration::from_secs(pick_secs(
            overrides.transfer_budget_secs,
            TRANSFER_BUDGET_ENV,
            DEFAULT_TRANSFER_BUDGET.as_secs(),
            1,
            7200,
        )?),
        lock_wait: Duration::from_secs(pick_secs(
            overrides.lock_wait_secs,
            LOCK_WAIT_ENV,
            DEFAULT_LOCK_WAIT.as_secs(),
            0,
            600,
        )?),
        retries: pick_u32(overrides.retries, RETRIES_ENV, DEFAULT_RETRIES, 0, 10)?,
        backoff_base: DEFAULT_BACKOFF_BASE,
        backoff_max: DEFAULT_BACKOFF_MAX,
    };
    if let Ok(raw) = std::env::var(BACKOFF_BASE_ENV) {
        let ms = parse_bound(&raw, BACKOFF_BASE_ENV, 0, 60_000)?;
        policy.backoff_base = Duration::from_millis(ms);
        // Keep the cap at least the base so a tiny test base does not invert
        // the backoff range.
        if policy.backoff_max < policy.backoff_base {
            policy.backoff_max = policy.backoff_base;
        }
    }
    // A transfer budget shorter than one idle window can never observe a
    // no-progress timeout; keep the relationship meaningful instead of
    // silently unreachable.
    if policy.transfer_budget < policy.idle_timeout {
        return Err(UpdateError::Policy(format!(
            "the total transfer budget ({}s) must be at least the no-progress timeout ({}s)",
            policy.transfer_budget.as_secs(),
            policy.idle_timeout.as_secs()
        )));
    }
    Ok(policy)
}

fn pick_secs(
    cli: Option<u64>,
    env_name: &str,
    default: u64,
    min: u64,
    max: u64,
) -> Result<u64, UpdateError> {
    if let Some(value) = cli {
        return bound(value, env_name, min, max);
    }
    match std::env::var(env_name) {
        Ok(raw) if !raw.trim().is_empty() => {
            let value = raw.trim().parse::<u64>().map_err(|_| {
                UpdateError::Policy(format!("{env_name} must be an integer in [{min}, {max}]"))
            })?;
            bound(value, env_name, min, max)
        }
        _ => Ok(default),
    }
}

fn pick_u32(
    cli: Option<u32>,
    env_name: &str,
    default: u32,
    min: u32,
    max: u32,
) -> Result<u32, UpdateError> {
    if let Some(value) = cli {
        if value < min || value > max {
            return Err(UpdateError::Policy(format!(
                "{env_name} must be in [{min}, {max}]; got {value}"
            )));
        }
        return Ok(value);
    }
    match std::env::var(env_name) {
        Ok(raw) if !raw.trim().is_empty() => {
            let value = raw.trim().parse::<u32>().map_err(|_| {
                UpdateError::Policy(format!("{env_name} must be an integer in [{min}, {max}]"))
            })?;
            if value < min || value > max {
                return Err(UpdateError::Policy(format!(
                    "{env_name} must be in [{min}, {max}]; got {value}"
                )));
            }
            Ok(value)
        }
        _ => Ok(default),
    }
}

fn bound(value: u64, name: &str, min: u64, max: u64) -> Result<u64, UpdateError> {
    if value < min || value > max {
        return Err(UpdateError::Policy(format!(
            "{name} must be in [{min}, {max}]; got {value}"
        )));
    }
    Ok(value)
}

fn parse_bound(raw: &str, name: &str, min: u64, max: u64) -> Result<u64, UpdateError> {
    let value = raw
        .trim()
        .parse::<u64>()
        .map_err(|_| UpdateError::Policy(format!("{name} must be an integer in [{min}, {max}]")))?;
    bound(value, name, min, max)
}

/// A monotonic deadline. Wall clocks can jump; budgets must not.
#[derive(Debug, Clone, Copy)]
pub struct Deadline {
    start: Instant,
    budget: Duration,
}

impl Deadline {
    pub fn after(budget: Duration) -> Self {
        Self {
            start: Instant::now(),
            budget,
        }
    }

    pub fn remaining(&self) -> Duration {
        self.budget
            .checked_sub(self.start.elapsed())
            .unwrap_or(Duration::ZERO)
    }

    pub fn expired(&self) -> bool {
        self.remaining().is_zero()
    }

    pub fn elapsed(&self) -> Duration {
        self.start.elapsed()
    }

    /// Cap a sleep so it never outlives the deadline.
    pub fn cap_sleep(&self, delay: Duration) -> Duration {
        delay.min(self.remaining())
    }
}

/// Exponential backoff with jitter, bounded by `max` and the remaining budget.
///
/// `jitter` is a uniform fraction in `[0.5, 1.0)` of the computed delay so
/// concurrent installers do not retry in lockstep. A zero base disables the
/// sleep entirely (deterministic tests).
pub fn backoff_delay(attempt: u32, base: Duration, max: Duration, remaining: Duration) -> Duration {
    if base.is_zero() {
        return Duration::ZERO;
    }
    let exponent = attempt.min(16);
    let scaled = base.saturating_mul(2u32.saturating_pow(exponent));
    let capped = scaled.min(max);
    let jitter = 0.5 + rand::random::<f64>() * 0.5;
    let jittered = capped.mul_f64(jitter);
    jittered.min(remaining)
}

/// Parse a `Retry-After` header value (delay-seconds form). HTTP-date forms
/// are not produced by the release endpoints; an unparseable value is ignored
/// rather than trusted.
pub fn parse_retry_after(value: &str) -> Option<Duration> {
    let secs = value.trim().parse::<u64>().ok()?;
    Some(Duration::from_secs(secs))
}

/// Whether an HTTP status is a transient failure worth a bounded retry.
pub fn is_retryable_status(status: u16) -> bool {
    matches!(status, 408 | 429 | 500 | 502 | 503 | 504)
}

/// Whether a reqwest transport error is transient (connect/read/idle class).
pub fn is_retryable_transport(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_body() || error.is_decode()
}

/// Strip credentials, query strings and fragments from a URL for diagnostics.
/// Signed download URLs and auth headers must never reach a log (#4592 §8.2).
pub fn redact_url(url: &str) -> String {
    let without_fragment = url.split('#').next().unwrap_or(url);
    let without_query = without_fragment
        .split('?')
        .next()
        .unwrap_or(without_fragment);
    // Strip userinfo (user:pass@host) if present.
    if let Some((scheme, rest)) = without_query.split_once("://") {
        if let Some((_, host)) = rest.rsplit_once('@') {
            return format!("{scheme}://{host}");
        }
    }
    without_query.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    fn clear_env() {
        for name in [
            CONNECT_TIMEOUT_ENV,
            METADATA_TIMEOUT_ENV,
            IDLE_TIMEOUT_ENV,
            TRANSFER_BUDGET_ENV,
            LOCK_WAIT_ENV,
            RETRIES_ENV,
            BACKOFF_BASE_ENV,
        ] {
            std::env::remove_var(name);
        }
    }

    #[test]
    fn defaults_are_bounded_and_phase_specific() {
        let _guard = ENV_MUTEX.lock().unwrap();
        clear_env();
        let policy = resolve(&PolicyOverrides::default()).unwrap();
        assert_eq!(policy.connect_timeout, Duration::from_secs(10));
        assert_eq!(policy.metadata_timeout, Duration::from_secs(30));
        assert_eq!(policy.idle_timeout, Duration::from_secs(60));
        assert_eq!(policy.transfer_budget, Duration::from_secs(1800));
        assert_eq!(policy.lock_wait, Duration::from_secs(30));
        assert_eq!(policy.attempts(), 4);
        assert_ne!(policy.metadata_timeout, policy.transfer_budget);
    }

    #[test]
    fn env_overrides_are_validated() {
        let _guard = ENV_MUTEX.lock().unwrap();
        clear_env();
        std::env::set_var(IDLE_TIMEOUT_ENV, "2");
        std::env::set_var(TRANSFER_BUDGET_ENV, "20");
        std::env::set_var(RETRIES_ENV, "1");
        let policy = resolve(&PolicyOverrides::default()).unwrap();
        assert_eq!(policy.idle_timeout, Duration::from_secs(2));
        assert_eq!(policy.transfer_budget, Duration::from_secs(20));
        assert_eq!(policy.attempts(), 2);

        std::env::set_var(IDLE_TIMEOUT_ENV, "0");
        assert!(matches!(
            resolve(&PolicyOverrides::default()),
            Err(UpdateError::Policy(_))
        ));
        std::env::set_var(IDLE_TIMEOUT_ENV, "not-a-number");
        assert!(matches!(
            resolve(&PolicyOverrides::default()),
            Err(UpdateError::Policy(_))
        ));
        clear_env();
    }

    #[test]
    fn cli_overrides_beat_env() {
        let _guard = ENV_MUTEX.lock().unwrap();
        clear_env();
        std::env::set_var(IDLE_TIMEOUT_ENV, "5");
        let overrides = PolicyOverrides {
            idle_timeout_secs: Some(3),
            transfer_budget_secs: Some(30),
            ..Default::default()
        };
        let policy = resolve(&overrides).unwrap();
        assert_eq!(policy.idle_timeout, Duration::from_secs(3));
        clear_env();
    }

    #[test]
    fn a_budget_shorter_than_the_idle_window_is_refused() {
        let _guard = ENV_MUTEX.lock().unwrap();
        clear_env();
        let overrides = PolicyOverrides {
            idle_timeout_secs: Some(30),
            transfer_budget_secs: Some(10),
            ..Default::default()
        };
        assert!(matches!(resolve(&overrides), Err(UpdateError::Policy(_))));
    }

    #[test]
    fn out_of_range_cli_values_are_refused() {
        let _guard = ENV_MUTEX.lock().unwrap();
        clear_env();
        let overrides = PolicyOverrides {
            retries: Some(99),
            ..Default::default()
        };
        assert!(matches!(resolve(&overrides), Err(UpdateError::Policy(_))));
        let overrides = PolicyOverrides {
            connect_timeout_secs: Some(0),
            ..Default::default()
        };
        assert!(matches!(resolve(&overrides), Err(UpdateError::Policy(_))));
    }

    #[test]
    fn deadline_is_monotonic_and_caps_sleeps() {
        let deadline = Deadline::after(Duration::from_secs(60));
        assert!(!deadline.expired());
        assert!(deadline.remaining() <= Duration::from_secs(60));
        // A sleep beyond the budget is capped to the remaining time. The
        // monotonic clock advances between reads, so bound the result between
        // the readings taken around the call instead of asserting equality.
        let before = deadline.remaining();
        let capped = deadline.cap_sleep(Duration::from_secs(120));
        let after = deadline.remaining();
        assert!(capped <= before, "{capped:?} > {before:?}");
        assert!(capped >= after, "{capped:?} < {after:?}");
        // A sleep inside the budget passes through unchanged.
        assert_eq!(
            deadline.cap_sleep(Duration::from_millis(1)),
            Duration::from_millis(1)
        );
        let expired = Deadline::after(Duration::ZERO);
        assert!(expired.expired());
        assert_eq!(expired.remaining(), Duration::ZERO);
        assert_eq!(expired.cap_sleep(Duration::from_secs(5)), Duration::ZERO);
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        let base = Duration::from_millis(100);
        let max = Duration::from_secs(1);
        let remaining = Duration::from_secs(60);
        let first = backoff_delay(0, base, max, remaining);
        let later = backoff_delay(4, base, max, remaining);
        assert!(first <= base);
        assert!(later <= max);
        assert!(later >= first);
        assert_eq!(
            backoff_delay(3, Duration::ZERO, max, remaining),
            Duration::ZERO
        );
        assert!(
            backoff_delay(0, base, max, Duration::from_millis(10)) <= Duration::from_millis(10)
        );
    }

    #[test]
    fn retry_after_parses_seconds_only() {
        assert_eq!(parse_retry_after("12"), Some(Duration::from_secs(12)));
        assert_eq!(parse_retry_after(" 7 "), Some(Duration::from_secs(7)));
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT"), None);
        assert_eq!(parse_retry_after("-3"), None);
    }

    #[test]
    fn transient_statuses_are_classified() {
        for status in [408, 429, 500, 502, 503, 504] {
            assert!(is_retryable_status(status), "{status}");
        }
        for status in [200, 206, 301, 400, 401, 403, 404, 410, 416] {
            assert!(!is_retryable_status(status), "{status}");
        }
    }

    #[test]
    fn urls_are_redacted_for_diagnostics() {
        assert_eq!(
            redact_url("https://host/path?X-Amz-Signature=secret&token=abc#frag"),
            "https://host/path"
        );
        assert_eq!(
            redact_url("https://user:pass@host/path"),
            "https://host/path"
        );
        assert_eq!(redact_url("https://host/path"), "https://host/path");
    }
}
