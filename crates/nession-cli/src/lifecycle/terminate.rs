//! Verified termination shared by the Agent and Server `stop` commands.
//!
//! `stop` starts from an owned [`ProcessIdentity`] (#1016), never from a bare
//! pid. The same proof must hold at the *second* signal: the graceful grace
//! period runs for seconds, and a process that exits during it can have its pid
//! reused before the timeout expires. Signalling the stale number then hits an
//! unrelated process (#3232 F6).
//!
//! So SIGKILL is sent only after `pid_file::ownership` answers
//! [`Ownership::Alive`] for the same state file one more time. A process that
//! already exited, a reused pid, and an unreadable identity all leave the pid
//! untouched. The ordinary timeout path is unchanged: a process that ignored
//! SIGTERM and still owns the state file is force-killed.

use crate::lifecycle::pid_file::{self, Component, Ownership, ProcessIdentity};
use anyhow::{bail, Context, Result};
use std::time::Duration;

/// How long SIGTERM gets before the second identity check.
pub const GRACE_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// How long a force-killed process gets to disappear before it is reported as
/// still running.
const KILL_SETTLE: Duration = Duration::from_millis(500);

fn label(component: Component) -> &'static str {
    match component {
        Component::Agent => "Agent",
        Component::Server => "Server",
    }
}

/// Stop one process whose identity was verified by the caller.
pub async fn stop_verified(
    record_path: &str,
    identity: &ProcessIdentity,
    component: Component,
) -> Result<()> {
    stop_verified_with_timeout(record_path, identity, component, GRACE_TIMEOUT).await
}

/// The grace period is injectable so cancellation and identity changes can be
/// exercised without a five-second test.
pub(crate) async fn stop_verified_with_timeout(
    record_path: &str,
    identity: &ProcessIdentity,
    component: Component,
    grace: Duration,
) -> Result<()> {
    let label = label(component);
    let pid = identity.pid;
    println!("Stopping {} (PID {pid})...", label.to_lowercase());

    signal(pid, Signal::Term).context("failed to send SIGTERM")?;

    let deadline = std::time::Instant::now() + grace;
    loop {
        if !pid_file::is_process_running(pid) {
            println!("{label} stopped successfully");
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }

    // The pid still answers, but that is not the claim that matters. Re-read
    // the record and re-check the OS start time before the forceful signal.
    match pid_file::ownership(record_path) {
        Ok(Ownership::Alive(current)) if current.pid == pid => {
            println!("{label} didn't stop gracefully, sending SIGKILL...");
            signal(pid, Signal::Kill).context("failed to send SIGKILL")?;
        }
        Ok(Ownership::Alive(current)) => {
            println!(
                "State file {record_path} now records PID {} while this stop was for PID {pid}; \
                 not sending SIGKILL.",
                current.pid
            );
            return Ok(());
        }
        Ok(Ownership::Reused(current)) => {
            println!(
                "PID {pid} now belongs to a different process (recorded start {}, expected {}); \
                 not sending SIGKILL.",
                current.started_at, identity.started_at
            );
            return Ok(());
        }
        Ok(Ownership::Stale(_)) => {
            println!("{label} exited during the grace period; not sending SIGKILL");
            return Ok(());
        }
        Err(error) => bail!(
            "cannot re-verify that PID {pid} is still the recorded {label} before SIGKILL \
             (state file {record_path}: {error}); refusing to signal it.\n\
             Fix: inspect the process and the state file, then run `nession {} stop` again.",
            component.as_str()
        ),
    }

    tokio::time::sleep(KILL_SETTLE).await;

    if !pid_file::is_process_running(pid) {
        println!("{label} stopped (force killed)");
        return Ok(());
    }
    match pid_file::ownership(record_path) {
        Ok(Ownership::Alive(current)) if current.pid == pid => {
            bail!("Failed to stop {} process {pid}", component.as_str())
        }
        // The recorded instance is gone even though its old number now names
        // something else: the stop succeeded, and the new holder was never
        // signalled.
        Ok(Ownership::Alive(_)) | Ok(Ownership::Reused(_)) | Ok(Ownership::Stale(_)) => {
            println!("{label} stopped (force killed)");
            Ok(())
        }
        Err(error) => bail!(
            "sent SIGKILL to PID {pid} but cannot re-verify the result \
             (state file {record_path}: {error}).\n\
             Fix: inspect `ps -p {pid}` and the state file."
        ),
    }
}

/// The two signals this module sends. Named so the call sites read as the
/// contract, and so non-Unix builds cannot silently skip the handling above.
#[derive(Debug, Clone, Copy)]
enum Signal {
    Term,
    Kill,
}

#[cfg(unix)]
fn signal(pid: u32, signal: Signal) -> Result<()> {
    use nix::sys::signal::{kill, Signal as NixSignal};
    use nix::unistd::Pid;

    let signal = match signal {
        Signal::Term => NixSignal::SIGTERM,
        Signal::Kill => NixSignal::SIGKILL,
    };
    kill(Pid::from_raw(pid as i32), signal).map_err(Into::into)
}

#[cfg(not(unix))]
fn signal(_pid: u32, _signal: Signal) -> Result<()> {
    bail!("process signalling is only supported on Unix hosts")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use tempfile::TempDir;

    /// A process that ignores SIGTERM, so the grace period genuinely expires.
    ///
    /// It is started through a short-lived shell and orphaned on purpose: a
    /// direct child that is SIGKILLed stays a zombie until reaped, and a zombie
    /// still answers `kill(pid, 0)` — the very liveness reading `stop` uses.
    /// Production targets an orphaned daemon, so the test does too.
    struct Stubborn {
        pid: u32,
    }

    impl Stubborn {
        fn spawn() -> Self {
            let output = std::process::Command::new("sh")
                .arg("-c")
                .arg("(trap '' TERM; while :; do sleep 1; done) >/dev/null 2>&1 & echo $!")
                .output()
                .expect("spawn a SIGTERM-ignoring child");
            assert!(output.status.success(), "the helper shell failed");
            let pid = String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<u32>()
                .expect("the helper shell reported its child pid");
            Self { pid }
        }

        fn pid(&self) -> u32 {
            self.pid
        }
    }

    impl Drop for Stubborn {
        fn drop(&mut self) {
            unsafe {
                libc::kill(self.pid as i32, libc::SIGKILL);
            }
        }
    }

    fn identity(pid: u32) -> ProcessIdentity {
        let mut identity = pid_file::ProcessIdentity::of_current_process(Component::Agent).unwrap();
        identity.pid = pid;
        // The recorded start time is the child's, not this test process's.
        identity.started_at =
            pid_file::start_time_of_pid(pid).expect("the child has a readable start time");
        identity
    }

    fn write_record(path: &Path, identity: &ProcessIdentity) {
        fs::write(
            path,
            format!(
                "pid={}\nstarted_at={}\nkind={}\nversion={}\n",
                identity.pid,
                identity.started_at,
                identity.kind.as_str(),
                identity.release_version.as_deref().unwrap_or_default()
            ),
        )
        .unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[tokio::test]
    async fn a_timeout_force_kills_the_same_recorded_process() {
        let dir = TempDir::new().unwrap();
        let record = dir.path().join("agent.pid");
        let child = Stubborn::spawn();
        assert!(pid_file::is_process_running(child.pid()));
        let identity = identity(child.pid());
        write_record(&record, &identity);

        stop_verified_with_timeout(
            record.to_str().unwrap(),
            &identity,
            Component::Agent,
            Duration::from_millis(300),
        )
        .await
        .expect("the still-owned process is force killed");

        assert!(
            !pid_file::is_process_running(child.pid()),
            "the ordinary timeout must still terminate the original process"
        );
    }

    #[tokio::test]
    async fn an_identity_change_before_sigkill_is_not_signalled() {
        let dir = TempDir::new().unwrap();
        let record = dir.path().join("agent.pid");
        let child = Stubborn::spawn();
        let identity = identity(child.pid());
        write_record(&record, &identity);

        // Make the record describe a different instance while the child keeps
        // running: exactly what a reused pid looks like from `stop`'s side.
        let mut reused = identity.clone();
        reused.started_at = reused.started_at.saturating_add(60);
        let path = record.to_str().unwrap().to_string();
        let stop = tokio::spawn(async move {
            stop_verified_with_timeout(
                &path,
                &identity,
                Component::Agent,
                Duration::from_millis(300),
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(150)).await;
        write_record(&record, &reused);

        stop.await
            .expect("the stop task completed")
            .expect("an identity mismatch is a safe no-op, not a failure");
        assert!(
            pid_file::is_process_running(child.pid()),
            "a pid whose recorded identity changed must never be SIGKILLed"
        );
    }

    #[tokio::test]
    async fn an_unreadable_identity_refuses_sigkill() {
        let dir = TempDir::new().unwrap();
        let record = dir.path().join("agent.pid");
        let child = Stubborn::spawn();
        let identity = identity(child.pid());
        write_record(&record, &identity);

        let path = record.to_str().unwrap().to_string();
        let stop = tokio::spawn(async move {
            stop_verified_with_timeout(
                &path,
                &identity,
                Component::Agent,
                Duration::from_millis(300),
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(150)).await;
        fs::remove_file(&record).unwrap();

        let error = stop
            .await
            .expect("the stop task completed")
            .expect_err("an unverifiable identity must fail closed");
        assert!(
            error.to_string().contains("refusing to signal"),
            "the error must name the refusal: {error}"
        );
        assert!(
            pid_file::is_process_running(child.pid()),
            "the process must survive when ownership cannot be re-proven"
        );
    }
}
