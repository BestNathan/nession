//! On-demand observation of Claude's Agent view (`#3779` P0).
//!
//! The control Tools answer "what is Claude doing now" from the official
//! `claude agents --json` command, never from a lifecycle-hook-maintained store
//! and never from the undocumented `jobs/state.json`. This module owns the
//! **observation contract**: the reported JSON shape is parsed into typed
//! states, and every unobservable case is a distinct answer.
//!
//! Process identity is deliberately *not* decided here. A status record names a
//! `pid`; whether that PID belongs to the specific Nession Session is the
//! Agent's existing process-discovery query (the host owns Session membership).
//! This module only says what Claude reported and whether it could observe.
//!
//! ## Compatibility is observed, not pre-gated
//!
//! The CLI is asked for `agents --json` and the answer decides the outcome:
//!
//! - a CLI that prints the shaped records is `Supported`, whatever version it
//!   reports — a newer (or older) CLI is never refused merely because its
//!   version is not in a list;
//! - an older CLI without the command is `Unsupported`, carrying the CLI's own
//!   refusal;
//! - a failed, timed-out or unparseable answer is `CannotObserve`;
//! - a missing executable is `Absent`.
//!
//! The captured `2.1.326` output remains the fixture that documents the shape
//! and its version is recorded for diagnostics, but it is not an admission
//! gate. No non-`Supported` answer is ever presented as `idle`.

use async_trait::async_trait;
use serde::Deserialize;

/// The command the probe runs. A Session's own environment and cwd are the
/// runner's responsibility; this module never reads the daemon's environment.
pub const AGENTS_JSON_COMMAND: &str = "agents";

/// One CLI invocation's result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOutput {
    /// Whether the process exited successfully.
    pub success: bool,
    /// Standard output.
    pub stdout: String,
    /// Standard error.
    pub stderr: String,
}

/// Why a CLI invocation could not produce a result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliFailure {
    /// No `claude` executable was found.
    NotFound,
    /// The executable exists but could not be started or did not finish
    /// (permission, timeout, signal). The Session must not read this as an
    /// observation of Claude state.
    Failed(String),
}

/// The host seam: run the official CLI in one Session's environment.
#[async_trait]
pub trait ClaudeCliRunner: Send + Sync {
    /// Run `claude <args>` with the Session's cwd/environment.
    async fn run(&self, args: &[&str]) -> Result<CliOutput, CliFailure>;
}

/// A parsed `claude --version` value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeCliVersion {
    /// The trimmed version token, e.g. `2.1.326`.
    pub raw: String,
    /// Major component.
    pub major: u64,
    /// Minor component.
    pub minor: u64,
    /// Patch component.
    pub patch: u64,
}

impl ClaudeCliVersion {
    /// Parse the version token from `claude --version`.
    ///
    /// The observed output is `2.1.326 (Claude Code)`; only the first token is
    /// the version. Anything that does not start with a dotted numeric triple
    /// is not a version this probe can record; it never decides whether the
    /// command's answer is interpreted.
    pub fn parse(output: &str) -> Option<Self> {
        let token = output.split_whitespace().next()?;
        let mut parts = token.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch_token = parts.next()?;
        let patch = patch_token
            .split(|c: char| !c.is_ascii_digit())
            .next()?
            .parse()
            .ok()?;
        Some(Self {
            raw: token.to_string(),
            major,
            minor,
            patch,
        })
    }
}

/// What kind of Claude process one record describes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentSessionKind {
    /// A live interactive Claude process (has a `pid`).
    Interactive,
    /// A background agent session.
    Background,
    /// A kind this build does not know.
    Unknown(String),
}

/// An interactive process's activity, exactly as reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeActivity {
    /// Working on a turn.
    Busy,
    /// Waiting for the user.
    Waiting {
        /// What it is waiting for, when reported.
        waiting_for: Option<String>,
    },
    /// Not working and not waiting.
    Idle,
    /// A status string this build does not know.
    Unknown(String),
}

/// A background session's state, exactly as reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackgroundState {
    /// Actively working.
    Working,
    /// Blocked on input or a condition.
    Blocked,
    /// Finished.
    Done,
    /// Failed.
    Failed,
    /// Stopped.
    Stopped,
    /// A state string this build does not know.
    Unknown(String),
}

/// One record from `claude agents --json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedAgentSession {
    /// Interactive or background.
    pub kind: AgentSessionKind,
    /// The OS process id, present on interactive records.
    pub pid: Option<u32>,
    /// Claude's conversation id, when it has one. `None` is an honest absence,
    /// not an invitation to guess from cwd or transcript recency.
    pub session_id: Option<String>,
    /// The working directory Claude reported.
    pub cwd: Option<String>,
    /// The display name Claude reported.
    pub name: Option<String>,
    /// Start time in milliseconds since the epoch.
    pub started_at_ms: Option<u64>,
    /// Interactive activity.
    pub activity: Option<ClaudeActivity>,
    /// Background state.
    pub background_state: Option<BackgroundState>,
}

/// The observation result. Every variant is an answer; an unknown or
/// unavailable state is never presented as idle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentViewObservation {
    /// The command is supported and the records parsed.
    Supported {
        /// The CLI version that answered, when `--version` was readable.
        ///
        /// Informational only: the version never decides whether the records
        /// are interpreted. `None` means the answer parsed but the version
        /// could not be read, not that the answer is suspect.
        version: Option<ClaudeCliVersion>,
        /// Live records in the order the CLI reported them.
        sessions: Vec<ObservedAgentSession>,
    },
    /// The CLI exists but does not offer the command.
    Unsupported {
        /// A bounded reason derived from the CLI's own failure.
        reason: String,
    },
    /// The CLI exists but this build cannot truthfully read its answer.
    CannotObserve {
        /// A bounded reason.
        reason: String,
    },
    /// No `claude` executable was found.
    Absent,
}

/// Raw record shape. Unknown fields are ignored; a record missing the fields
/// this module needs is not silently interpreted.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRecord {
    kind: Option<String>,
    pid: Option<u32>,
    session_id: Option<String>,
    cwd: Option<String>,
    name: Option<String>,
    started_at: Option<u64>,
    status: Option<String>,
    waiting_for: Option<String>,
    state: Option<String>,
}

/// Parse `claude agents --json` output.
///
/// `version` is carried into the answer for diagnostics only; the shape is
/// decided by the records, not by which version printed them.
pub fn parse_agents_json(version: Option<ClaudeCliVersion>, stdout: &str) -> AgentViewObservation {
    let raw: Vec<RawRecord> = match serde_json::from_str(stdout) {
        Ok(raw) => raw,
        Err(error) => {
            return AgentViewObservation::CannotObserve {
                reason: format!("`claude agents --json` did not print a JSON array: {error}"),
            }
        }
    };
    let mut sessions = Vec::with_capacity(raw.len());
    for (index, record) in raw.into_iter().enumerate() {
        let Some(kind) = record.kind else {
            return AgentViewObservation::CannotObserve {
                reason: format!("record {index} has no `kind`"),
            };
        };
        let kind = match kind.as_str() {
            "interactive" => AgentSessionKind::Interactive,
            "background" => AgentSessionKind::Background,
            other => AgentSessionKind::Unknown(other.to_string()),
        };
        let activity = record.status.map(|status| match status.as_str() {
            "busy" => ClaudeActivity::Busy,
            "idle" => ClaudeActivity::Idle,
            "waiting" => ClaudeActivity::Waiting {
                waiting_for: record.waiting_for.clone(),
            },
            other => ClaudeActivity::Unknown(other.to_string()),
        });
        let background_state = record.state.map(|state| match state.as_str() {
            "working" => BackgroundState::Working,
            "blocked" => BackgroundState::Blocked,
            "done" => BackgroundState::Done,
            "failed" => BackgroundState::Failed,
            "stopped" => BackgroundState::Stopped,
            other => BackgroundState::Unknown(other.to_string()),
        });
        sessions.push(ObservedAgentSession {
            kind,
            pid: record.pid,
            session_id: record.session_id,
            cwd: record.cwd,
            name: record.name,
            started_at_ms: record.started_at,
            activity,
            background_state,
        });
    }
    AgentViewObservation::Supported { version, sessions }
}

/// Probe the CLI on demand.
///
/// The runner supplies the Session's environment. The command is attempted
/// regardless of the CLI version: a missing binary, a rejected command, a
/// failed run and malformed output are distinct answers, and none of them is
/// `idle`. The version is read afterwards for diagnostics only.
pub async fn probe_agent_view(runner: &dyn ClaudeCliRunner) -> AgentViewObservation {
    let output = match runner.run(&[AGENTS_JSON_COMMAND, "--json"]).await {
        Ok(output) => output,
        Err(CliFailure::NotFound) => return AgentViewObservation::Absent,
        Err(CliFailure::Failed(reason)) => {
            return AgentViewObservation::CannotObserve {
                reason: format!("`claude agents --json` failed: {reason}"),
            }
        }
    };
    if !output.success {
        let stderr = output.stderr.to_ascii_lowercase();
        let reason = if stderr.contains("unknown command")
            || stderr.contains("unknown option")
            || stderr.contains("unrecognized")
        {
            return AgentViewObservation::Unsupported {
                reason: "this Claude CLI does not offer `agents --json`".to_string(),
            };
        } else {
            format!(
                "`claude agents --json` exited unsuccessfully: {}",
                bounded(&output.stderr)
            )
        };
        return AgentViewObservation::CannotObserve { reason };
    }
    // Best-effort version for diagnostics. A CLI that answers `agents --json`
    // but cannot report a version is still interpreted by its answer.
    let version = match runner.run(&["--version"]).await {
        Ok(version_output) if version_output.success => {
            ClaudeCliVersion::parse(&version_output.stdout)
        }
        _ => None,
    };
    parse_agents_json(version, &output.stdout)
}

/// A bounded, single-line diagnostic from a CLI's stderr.
fn bounded(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    line.chars().take(240).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from Claude CLI 2.1.326 on 2026-11-18: one interactive waiting
    /// process and one blocked background session.
    const OBSERVED: &str = r#"[
      {
        "id": "d02c55ea",
        "cwd": "/Users/admin/workspace/hs/hs-code-keeper/bbc",
        "kind": "background",
        "startedAt": 1790050864986,
        "sessionId": "d02c55ea-4373-45da-9f44-d79fbb4922e9",
        "name": "layer_base dev_params_edit",
        "state": "blocked"
      },
      {
        "pid": 76032,
        "cwd": "/Users/admin/workspace/learn/nession",
        "kind": "interactive",
        "startedAt": 1793844322228,
        "sessionId": "a460cce1-35c0-4b8f-9d5f-5ae899e72229",
        "name": "nession-84",
        "status": "waiting",
        "waitingFor": "input needed"
      }
    ]"#;

    fn version() -> ClaudeCliVersion {
        ClaudeCliVersion::parse("2.1.326 (Claude Code)").expect("version")
    }

    #[test]
    fn the_observed_shape_parses_into_typed_states() {
        let AgentViewObservation::Supported { version, sessions } =
            parse_agents_json(Some(version()), OBSERVED)
        else {
            panic!("the captured shape must parse");
        };
        assert_eq!(version.expect("version").raw, "2.1.326");
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].kind, AgentSessionKind::Background);
        assert_eq!(sessions[0].background_state, Some(BackgroundState::Blocked));
        assert_eq!(sessions[0].pid, None);
        assert_eq!(
            sessions[0].session_id.as_deref(),
            Some("d02c55ea-4373-45da-9f44-d79fbb4922e9")
        );
        assert_eq!(sessions[1].kind, AgentSessionKind::Interactive);
        assert_eq!(sessions[1].pid, Some(76032));
        assert_eq!(
            sessions[1].activity,
            Some(ClaudeActivity::Waiting {
                waiting_for: Some("input needed".to_string())
            })
        );
    }

    #[test]
    fn unknown_status_and_state_survive_verbatim() {
        let output = r#"[
          {"kind":"interactive","pid":1,"status":"pondering"},
          {"kind":"background","state":"queued"}
        ]"#;
        let AgentViewObservation::Supported { sessions, .. } =
            parse_agents_json(Some(version()), output)
        else {
            panic!("unknown values are still parseable");
        };
        assert_eq!(
            sessions[0].activity,
            Some(ClaudeActivity::Unknown("pondering".to_string()))
        );
        assert_eq!(
            sessions[1].background_state,
            Some(BackgroundState::Unknown("queued".to_string()))
        );
    }

    #[test]
    fn a_missing_conversation_id_is_none_not_a_guess() {
        let output = r#"[{"kind":"interactive","pid":7,"status":"idle"}]"#;
        let AgentViewObservation::Supported { sessions, .. } =
            parse_agents_json(Some(version()), output)
        else {
            panic!("parse");
        };
        assert_eq!(sessions[0].session_id, None);
        assert_eq!(sessions[0].activity, Some(ClaudeActivity::Idle));
    }

    #[test]
    fn malformed_or_non_array_output_is_cannot_observe() {
        for output in ["", "not json", "{\"sessions\":[]}", "[{\"pid\":1}]"] {
            assert!(
                matches!(
                    parse_agents_json(Some(version()), output),
                    AgentViewObservation::CannotObserve { .. }
                ),
                "{output}"
            );
        }
    }

    #[test]
    fn the_same_answer_parses_whatever_version_reports_it() {
        for raw in [
            "2.1.325 (Claude Code)",
            "2.1.326 (Claude Code)",
            "2.1.327 (Claude Code)",
            "3.0.0 (Claude Code)",
            "9.9.9-vendor-fork (vendor)",
        ] {
            let version = ClaudeCliVersion::parse(raw).expect("version");
            let AgentViewObservation::Supported {
                version: observed,
                sessions,
            } = parse_agents_json(Some(version), OBSERVED)
            else {
                panic!("{raw}: a shaped answer must parse");
            };
            assert_eq!(sessions.len(), 2, "{raw}");
            assert_eq!(
                observed.expect("version").raw,
                raw.split_whitespace().next().expect("token"),
                "{raw}"
            );
        }
    }

    struct FixtureRunner {
        version: Result<CliOutput, CliFailure>,
        agents: Result<CliOutput, CliFailure>,
    }

    #[async_trait]
    impl ClaudeCliRunner for FixtureRunner {
        async fn run(&self, args: &[&str]) -> Result<CliOutput, CliFailure> {
            if args == ["--version"] {
                self.version.clone()
            } else {
                self.agents.clone()
            }
        }
    }

    fn ok(stdout: &str) -> Result<CliOutput, CliFailure> {
        Ok(CliOutput {
            success: true,
            stdout: stdout.to_string(),
            stderr: String::new(),
        })
    }

    #[tokio::test]
    async fn a_missing_binary_is_absent() {
        let runner = FixtureRunner {
            version: Err(CliFailure::NotFound),
            agents: Err(CliFailure::NotFound),
        };
        assert_eq!(
            probe_agent_view(&runner).await,
            AgentViewObservation::Absent
        );
    }

    #[tokio::test]
    async fn an_unlisted_version_is_interpreted_by_its_answer() {
        let runner = FixtureRunner {
            version: ok("2.0.0 (Claude Code)\n"),
            agents: ok(OBSERVED),
        };
        let AgentViewObservation::Supported {
            version: observed,
            sessions,
        } = probe_agent_view(&runner).await
        else {
            panic!("a version outside the recorded matrix must not be pre-gated");
        };
        assert_eq!(sessions.len(), 2);
        assert_eq!(observed.expect("version").raw, "2.0.0");
    }

    #[tokio::test]
    async fn an_unreadable_version_does_not_hide_a_valid_answer() {
        let runner = FixtureRunner {
            version: ok("built from source\n"),
            agents: ok(OBSERVED),
        };
        let AgentViewObservation::Supported {
            version: observed,
            sessions,
        } = probe_agent_view(&runner).await
        else {
            panic!("the records are the answer, not the version string");
        };
        assert_eq!(sessions.len(), 2);
        assert_eq!(observed, None);
    }

    #[tokio::test]
    async fn an_older_cli_without_the_command_is_unsupported() {
        let runner = FixtureRunner {
            version: ok("2.0.0 (Claude Code)\n"),
            agents: Ok(CliOutput {
                success: false,
                stdout: String::new(),
                stderr: "error: unknown command 'agents'\n".to_string(),
            }),
        };
        assert!(matches!(
            probe_agent_view(&runner).await,
            AgentViewObservation::Unsupported { .. }
        ));
    }

    #[tokio::test]
    async fn a_cli_without_the_command_is_unsupported() {
        let runner = FixtureRunner {
            version: ok("2.1.326 (Claude Code)\n"),
            agents: Ok(CliOutput {
                success: false,
                stdout: String::new(),
                stderr: "error: unknown command 'agents'\n".to_string(),
            }),
        };
        assert!(matches!(
            probe_agent_view(&runner).await,
            AgentViewObservation::Unsupported { .. }
        ));
    }

    #[tokio::test]
    async fn a_failed_run_is_cannot_observe_not_absent_claude() {
        let runner = FixtureRunner {
            version: ok("2.1.326 (Claude Code)\n"),
            agents: Err(CliFailure::Failed("timed out after 5s".to_string())),
        };
        assert!(matches!(
            probe_agent_view(&runner).await,
            AgentViewObservation::CannotObserve { reason } if reason.contains("timed out")
        ));
    }

    #[tokio::test]
    async fn the_supported_path_reports_the_captured_records() {
        let runner = FixtureRunner {
            version: ok("2.1.326 (Claude Code)\n"),
            agents: ok(OBSERVED),
        };
        let AgentViewObservation::Supported { sessions, .. } = probe_agent_view(&runner).await
        else {
            panic!("verified probe");
        };
        assert_eq!(sessions.len(), 2);
    }
}
