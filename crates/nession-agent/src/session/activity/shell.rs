//! Shell foreground-work Session Activity provider (#3802).
//!
//! A tmux-backed interactive Shell shows `working` while a foreground command
//! runs and `idle` only once the shell has its prompt back. The evidence is
//! the **Pane root's own and terminal-foreground process groups**, not terminal
//! output, CPU use, a command name alone, or a `no output for N seconds`
//! timer. `session::process_discovery::process_groups` reads both with one
//! bounded per-platform observation (`/proc/<pid>/stat` on Linux,
//! `PROC_PIDTBSDINFO` on macOS):
//!
//! - the root's **own** group is the interactive shell's group (unless the
//!   Pane was `exec`'d into something else);
//! - its **terminal foreground** group is whichever job the terminal drives.
//!
//! At a prompt those are the same group, so a foreground command — including
//! a silent one, a pipeline, an interactive TUI or a `bash -c` child named
//! `bash` — has a different group and is `working`. A background job (`&`)
//! leaves the shell's group in the foreground and is `idle`, as the issue
//! requires. Every missing or failed probe is `None` (the coordinator projects
//! `unknown`), never a guessed `idle`.
//!
//! ## What this provider does not own
//!
//! It is the **generic Shell** claimant. A command a specialized provider owns
//! (Claude, Codex, Qwen) is never claimed here: Shell returns `None`, so the
//! Pane stays `unknown` until that capability reports — the coordinator already
//! prefers a specialized claim, and this yield keeps Shell from reporting
//! `working` for an agent CLI on an Agent that does not compose its adapter.
//! The list is a yield list, not a status oracle.
//!
//! Non-interactive foreground apps are `working` from foreground evidence
//! alone; a Pane that has been `exec`'d into a non-shell process has no prompt
//! to return to, so the process itself is the work.
//!
//! ## Bounds and portability
//!
//! One bounded per-platform read per Pane per probe, no process-table scan and
//! no spawned process. Linux and macOS share the same contract; an unavailable
//! group is `unknown`, which is what the issue requires of an unsupported
//! detector.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use async_trait::async_trait;
use nession_common::session_activity::{
    ActivityLevel, ActivityState, SessionActivityContext, SessionActivityProvider, WorkloadClass,
};

use crate::session::process_discovery;

/// Interactive shells whose own group in the foreground means "at a prompt".
///
/// tmux reports the Pane's foreground command name; an unrecognized shell is
/// not classified `idle` (that would turn an unsupported shell into a lie) —
/// only the group comparison below is allowed to say `idle`.
const INTERACTIVE_SHELLS: &[&str] = &[
    "bash", "zsh", "sh", "dash", "ksh", "mksh", "fish", "csh", "tcsh", "nu", "elvish", "xonsh",
    "pwsh",
];

/// Foreground commands owned by a specialized capability, never by Shell.
///
/// This is a **yield**, not an observation: the matching provider must verify
/// the workload and report its own state. Without one composed, the Pane is
/// `unknown` rather than a Shell `working` claim derived from a name.
const SPECIALIZED_FOREGROUND: &[&str] = &["claude", "codex", "qwen"];

/// The generic Shell foreground-work provider.
///
/// Stateless apart from the monotonic source ordering: the coordinator already
/// owns Pane identity, generations and aggregation.
#[derive(Debug, Default)]
pub struct ShellActivityProvider {
    sequence: AtomicU64,
}

impl ShellActivityProvider {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl SessionActivityProvider for ShellActivityProvider {
    fn id(&self) -> &'static str {
        "shell"
    }

    fn class(&self) -> WorkloadClass {
        WorkloadClass::GenericShell
    }

    async fn probe(
        &self,
        context: &SessionActivityContext,
    ) -> anyhow::Result<Option<ActivityLevel>> {
        let command = context
            .foreground
            .as_ref()
            .and_then(|foreground| foreground.command.as_deref());
        if command.is_some_and(is_specialized) {
            return Ok(None);
        }

        // Without a Pane root there is no group evidence. A non-shell command
        // is still foreground work, so this is not an early refusal.
        let groups = context.pane_pid.and_then(process_discovery::process_groups);
        let evidence = PaneEvidence {
            command: command.map(str::to_string),
            foreground_group: groups.map(|(_, foreground)| foreground),
            root_group: groups.map(|(own, _)| own),
        };
        let Some(state) = classify(&evidence) else {
            return Ok(None);
        };

        Ok(Some(ActivityLevel {
            state,
            attention: None,
            workload_ref: context
                .foreground
                .as_ref()
                .map(|foreground| foreground.reference.clone()),
            source_generation: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
            observed_at: SystemTime::now(),
        }))
    }
}

/// The facts one classification is allowed to use.
///
/// Split from the syscalls so the decision table is deterministic and testable
/// without a terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PaneEvidence {
    command: Option<String>,
    foreground_group: Option<u32>,
    root_group: Option<u32>,
}

/// Classify one Pane, or `None` when the evidence cannot decide.
fn classify(evidence: &PaneEvidence) -> Option<ActivityState> {
    let command = evidence.command.as_deref()?;
    if is_specialized(command) {
        return None;
    }
    if !is_interactive_shell(command) {
        // A non-shell foreground process is the work itself. This includes a
        // Pane `exec`'d into an application, which has no prompt to return to.
        return Some(ActivityState::Working);
    }
    match (evidence.foreground_group, evidence.root_group) {
        (Some(foreground), Some(root)) if foreground == root => Some(ActivityState::Idle),
        (Some(_), Some(_)) => Some(ActivityState::Working),
        // A shell command with no group evidence is exactly the unsupported
        // detector the issue says must not fabricate an answer.
        _ => None,
    }
}

fn is_specialized(command: &str) -> bool {
    SPECIALIZED_FOREGROUND
        .iter()
        .any(|known| command.eq_ignore_ascii_case(known))
}

fn is_interactive_shell(command: &str) -> bool {
    INTERACTIVE_SHELLS
        .iter()
        .any(|known| command.eq_ignore_ascii_case(known))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nession_common::session_activity::ForegroundFacts;

    fn context(command: Option<&str>, pid: Option<u32>) -> SessionActivityContext {
        SessionActivityContext {
            session_name: "dev".to_string(),
            session_instance_id: "inc-1".to_string(),
            pane_id: "%1".to_string(),
            pane_pid: pid,
            foreground: command.map(|command| ForegroundFacts {
                reference: format!("%1:{command}"),
                command: Some(command.to_string()),
            }),
            owner_generation: 1,
        }
    }

    fn evidence(command: &str, foreground: Option<u32>, root: Option<u32>) -> PaneEvidence {
        PaneEvidence {
            command: Some(command.to_string()),
            foreground_group: foreground,
            root_group: root,
        }
    }

    #[test]
    fn the_shells_own_group_in_the_foreground_is_the_prompt() {
        assert_eq!(
            classify(&evidence("bash", Some(100), Some(100))),
            Some(ActivityState::Idle)
        );
        assert_eq!(
            classify(&evidence("zsh", Some(42), Some(42))),
            Some(ActivityState::Idle)
        );
    }

    #[test]
    fn a_foreground_job_of_any_kind_is_working() {
        // A separate foreground group is a foreground job, regardless of what
        // the job is called — this is what makes a `bash -c` child named
        // `bash`, a pipeline and a TUI all working rather than a guessed idle.
        assert_eq!(
            classify(&evidence("bash", Some(200), Some(100))),
            Some(ActivityState::Working)
        );
        assert_eq!(
            classify(&evidence("sleep", Some(200), Some(100))),
            Some(ActivityState::Working)
        );
        assert_eq!(
            classify(&evidence("vim", Some(200), Some(100))),
            Some(ActivityState::Working)
        );
        assert_eq!(
            classify(&evidence("cargo", None, None)),
            Some(ActivityState::Working),
            "a non-shell foreground command is the work even without group evidence"
        );
        // A Pane `exec`'d into a non-shell has no interactive shell to regain a
        // prompt, so the process itself remains working.
        assert_eq!(
            classify(&evidence("sleep", Some(100), Some(100))),
            Some(ActivityState::Working)
        );
    }

    #[test]
    fn a_shell_without_group_evidence_is_unknown_not_idle() {
        assert_eq!(classify(&evidence("bash", None, Some(100))), None);
        assert_eq!(classify(&evidence("bash", Some(100), None)), None);
        assert_eq!(classify(&evidence("bash", None, None)), None);
    }

    #[test]
    fn an_unknown_shell_name_is_not_promoted_to_idle() {
        // The only `idle` is the group comparison on a known shell. A custom
        // shell name falls through to foreground work rather than a guessed
        // prompt state.
        assert_eq!(
            classify(&evidence("myshell", Some(100), Some(100))),
            Some(ActivityState::Working)
        );
    }

    #[test]
    fn a_specialized_foreground_is_yielded_not_claimed() {
        assert_eq!(classify(&evidence("claude", Some(100), Some(100))), None);
        assert_eq!(classify(&evidence("codex", Some(200), Some(100))), None);
    }

    #[tokio::test]
    async fn a_specialized_command_or_missing_identity_produces_no_claim() {
        let provider = ShellActivityProvider::new();
        assert!(provider
            .probe(&context(Some("claude"), Some(42)))
            .await
            .unwrap()
            .is_none());
        assert!(provider
            .probe(&context(None, Some(42)))
            .await
            .unwrap()
            .is_none());
        // A shell whose process groups cannot be read is unknown, while a
        // non-shell foreground command is still foreground work.
        assert!(provider
            .probe(&context(Some("bash"), Some(u32::MAX)))
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            provider
                .probe(&context(Some("cargo"), Some(u32::MAX)))
                .await
                .unwrap()
                .map(|level| level.state),
            Some(ActivityState::Working)
        );
    }

    #[test]
    fn source_generations_are_monotonic_across_panes() {
        let provider = ShellActivityProvider::new();
        let first = provider.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let second = provider.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        assert!(second > first);
    }
}

/// Real-tmux runtime proof for #3802 SC-01/SC-02.
///
/// A `--lib` test with the run's private socket, matching the #3800 runtime
/// test shape: the Case runtime can run these, while a nested integration-test
/// binary has hung there before. The provider itself never spawns tmux.
#[cfg(test)]
#[cfg(unix)]
mod runtime_tests {
    use super::*;
    use crate::session::activity::contexts_from_tmux;
    use crate::test_support::TestSession;
    use crate::tmux::manager::SessionManager;
    use std::time::Duration;
    use tokio::time::{sleep, timeout};

    async fn context_for(
        manager: &SessionManager,
        session_name: &str,
    ) -> Option<SessionActivityContext> {
        let sessions = manager.list_sessions().await.ok()?;
        let panes = manager.list_panes().await.ok()?;
        contexts_from_tmux(&sessions, &panes)
            .into_iter()
            .find(|context| context.session_name == session_name)
    }

    async fn wait_for_state(
        provider: &ShellActivityProvider,
        manager: &SessionManager,
        session_name: &str,
        expected: ActivityState,
    ) -> bool {
        timeout(Duration::from_secs(10), async {
            loop {
                if let Some(context) = context_for(manager, session_name).await {
                    if let Ok(Some(level)) = provider.probe(&context).await {
                        if level.state == expected {
                            return;
                        }
                    }
                }
                sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .is_ok()
    }

    async fn send_key(
        manager: &SessionManager,
        session_name: &str,
        key: &str,
    ) -> anyhow::Result<()> {
        let output = manager
            .tmux_dep()
            .cmd()
            .output(&["send-keys", "-t", session_name, key])
            .await?;
        if !output.status.success() {
            anyhow::bail!(
                "tmux send-keys {key} failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }

    async fn start(manager: &SessionManager, prefix: &str) -> TestSession {
        let session = TestSession::new(prefix);
        manager
            .create_session(session.name(), 80, 24, "/tmp", &[])
            .await
            .expect("tmux creates the fixture Session");
        session
    }

    #[tokio::test]
    async fn a_real_pane_tracks_prompt_foreground_job_and_background_job() {
        let manager = SessionManager::new();
        let session = start(&manager, "shell-activity").await;
        let provider = ShellActivityProvider::new();

        assert!(
            wait_for_state(&provider, &manager, session.name(), ActivityState::Idle).await,
            "an interactive shell at its prompt is idle"
        );

        manager
            .tmux_dep()
            .ops()
            .send_keys(session.name(), "sleep 30")
            .await
            .expect("the shell runs a silent foreground command");
        assert!(
            wait_for_state(&provider, &manager, session.name(), ActivityState::Working).await,
            "a silent foreground command is working"
        );

        send_key(&manager, session.name(), "C-c")
            .await
            .expect("SIGINT reaches the pane");
        assert!(
            wait_for_state(&provider, &manager, session.name(), ActivityState::Idle).await,
            "regaining the prompt is idle"
        );

        manager
            .tmux_dep()
            .ops()
            .send_keys(session.name(), "sleep 30 &")
            .await
            .expect("the shell starts a background job");
        assert!(
            wait_for_state(&provider, &manager, session.name(), ActivityState::Idle).await,
            "a backgrounded job does not hold the foreground shell working"
        );
    }

    #[tokio::test]
    async fn a_silent_interactive_reader_is_working_not_inferred_from_output() {
        let manager = SessionManager::new();
        let session = start(&manager, "shell-cat").await;
        let provider = ShellActivityProvider::new();

        assert!(wait_for_state(&provider, &manager, session.name(), ActivityState::Idle).await);
        manager
            .tmux_dep()
            .ops()
            .send_keys(session.name(), "cat")
            .await
            .expect("cat runs in the foreground");
        assert!(
            wait_for_state(&provider, &manager, session.name(), ActivityState::Working).await,
            "`cat` producing no output is still foreground work"
        );
        send_key(&manager, session.name(), "C-c")
            .await
            .expect("SIGINT reaches cat");
        assert!(wait_for_state(&provider, &manager, session.name(), ActivityState::Idle).await);
    }

    /// An explicitly chosen shell, with the durable instance identity the
    /// coordinator fences on. `None` when the shell is not installed on this
    /// host (the Linux CI image has bash; zsh is covered when present).
    async fn start_shell(
        manager: &SessionManager,
        prefix: &str,
        shell: &str,
    ) -> Option<TestSession> {
        // not-tmux: probes whether the shell binary is installed; tmux is
        // asked to run it only through the canonical TmuxDep below.
        let installed = std::process::Command::new(shell)
            .arg("-c")
            .arg("exit 0")
            .status()
            .is_ok_and(|status| status.success());
        if !installed {
            return None;
        }
        let session = TestSession::new(prefix);
        let ops = manager.tmux_dep().ops();
        ops.new_session(&nession_tmux::ops::NewSession {
            name: session.name().to_string(),
            working_dir: "/tmp".to_string(),
            width: 80,
            height: 24,
            env: Vec::new(),
            command: vec![shell.to_string()],
        })
        .await
        .expect("tmux creates the explicit-shell Session");
        let instance_id = format!("fixture-{prefix}");
        ops.set_option(session.name(), "@nession_instance_id", &instance_id)
            .await
            .expect("the fixture Session carries a durable instance id");
        Some(session)
    }

    #[tokio::test]
    async fn explicit_bash_and_zsh_panes_follow_foreground_work() {
        let manager = SessionManager::new();
        let provider = ShellActivityProvider::new();
        for shell in ["bash", "zsh"] {
            let Some(session) = start_shell(&manager, shell, shell).await else {
                continue;
            };
            assert!(
                wait_for_state(&provider, &manager, session.name(), ActivityState::Idle).await,
                "{shell} at its prompt is idle"
            );
            manager
                .tmux_dep()
                .ops()
                .send_keys(session.name(), "sleep 30")
                .await
                .expect("the shell runs a foreground command");
            assert!(
                wait_for_state(&provider, &manager, session.name(), ActivityState::Working).await,
                "{shell} running a silent foreground command is working"
            );
            send_key(&manager, session.name(), "C-c")
                .await
                .expect("SIGINT reaches the pane");
            assert!(
                wait_for_state(&provider, &manager, session.name(), ActivityState::Idle).await,
                "{shell} regaining its prompt is idle"
            );
        }
    }

    #[tokio::test]
    async fn a_pipeline_and_a_shell_builtin_converge_truthfully() {
        let manager = SessionManager::new();
        let session = start(&manager, "shell-pipeline").await;
        let provider = ShellActivityProvider::new();

        assert!(wait_for_state(&provider, &manager, session.name(), ActivityState::Idle).await);
        manager
            .tmux_dep()
            .ops()
            .send_keys(session.name(), "sleep 30 | cat")
            .await
            .expect("the shell runs a pipeline");
        assert!(
            wait_for_state(&provider, &manager, session.name(), ActivityState::Working).await,
            "a pipeline's foreground group is working"
        );
        send_key(&manager, session.name(), "C-c")
            .await
            .expect("SIGINT reaches the pipeline");
        assert!(wait_for_state(&provider, &manager, session.name(), ActivityState::Idle).await);

        // A builtin runs in the shell's own process group: the provider must
        // not invent a foreground job for it.
        manager
            .tmux_dep()
            .ops()
            .send_keys(session.name(), "read x")
            .await
            .expect("a builtin waits for input");
        let context = context_for(&manager, session.name())
            .await
            .expect("the Session is observed");
        let level = provider.probe(&context).await.expect("probe runs");
        assert!(
            !matches!(level.map(|level| level.state), Some(ActivityState::Working)),
            "a shell builtin is not a foreground job"
        );
        send_key(&manager, session.name(), "C-c")
            .await
            .expect("SIGINT leaves the builtin");
    }
}
