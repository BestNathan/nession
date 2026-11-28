//! The one owner of "which conversations does this Session see, and which is
//! current" (#4664 D1–D7).
//!
//! ## Why this exists
//!
//! The read units used to answer that question with a single inferred fact:
//! the transcripts whose head-window `cwd` equals the tmux pane's cwd. The
//! hook-reported binding — the capability's own doctrine calls it *reported*,
//! not inferred — was then filtered against that list, and matched by
//! transcript-path equality. A resumed conversation breaks both assumptions at
//! once: its recorded cwd drifts (a persistent Bash-tool `cd`, a resume that
//! restores the drifted cwd and rewrites the transcript head) while the pane
//! shell never moved, and the hook's claimed `transcript_path` can name a file
//! that does not exist while the live file stays where the conversation was
//! created. The control path, which asks the running CLI for its own identity,
//! kept verifying a conversation the read path could not see (#4664's measured
//! bbc-devparams case).
//!
//! ## The doctrine
//!
//! **Identity is the join key; reported evidence outranks inferred cwd for the
//! session's own conversation.** Strict cwd matching (#1005 decision 7) remains
//! the rule for *unreported candidates* — no parent, no git root, no
//! subdirectory, no cross-directory leakage. The union adds exactly the
//! conversations this session instance has evidence for: its current binding,
//! its lifecycle history, and the host's fresh verified observation. Each is
//! resolved to a real transcript by identity ([`conversation::resolve_by_identity`]);
//! a report that resolves to nothing contributes nothing, because an
//! unprovable answer is worse than none (#1005 constraint 1).
//!
//! The current conversation is the freshest reported evidence: the live
//! verified observation first (the running CLI's own answer), then the latest
//! lifecycle report, then the history's last report. Activity stays the host's
//! foreground-command answer — this module decides *which* conversation, never
//! whether Claude is running.

use crate::binding::Binding;
use crate::conversation::{self, Discovered};
use crate::session_context::SessionContext;

/// What one Session sees, resolved once for every read unit.
pub struct ResolvedSession {
    /// The pane cwd the host reported — the candidate scope, and the answer's
    /// `cwd` field. A listed conversation's own `cwd` may differ: it is the
    /// transcript's recorded cwd, display metadata, not a scope key.
    pub cwd: String,
    /// The conversation list: strict-cwd candidates ∪ reported conversations,
    /// deduped by identity, newest-first (the listing order, not a selection).
    pub conversations: Vec<Discovered>,
    /// The current conversation, when reported evidence resolves to one.
    /// Always a member of `conversations` — the wire invariant that the
    /// binding's id is one of the items' ids is structural here.
    pub current: Option<Discovered>,
    /// Reported primaries the cwd scope did not already contain. Their
    /// sidechains need reach through them ([`Self::transcripts`]).
    reported_extras: Vec<Discovered>,
}

impl ResolvedSession {
    /// The transcript list: the conversation list plus every primary's
    /// subagents, deduped by identity, newest-first.
    ///
    /// [`conversation::transcripts_at`] reaches sidechains through cwd-matched
    /// sessions; a reported primary whose cwd drifted is reached through its
    /// report instead, so its subagents stay readable (#4664 D7).
    pub fn transcripts(&self) -> Vec<Discovered> {
        let mut found = conversation::transcripts_at(&self.cwd);
        for primary in &self.reported_extras {
            if !found
                .iter()
                .any(|t| t.claude_session_id == primary.claude_session_id)
            {
                found.push(primary.clone());
            }
            for side in conversation::sidechains_of(primary) {
                if !found
                    .iter()
                    .any(|t| t.claude_session_id == side.claude_session_id)
                {
                    found.push(side);
                }
            }
        }
        found.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        found
    }
}

/// Resolve one Session's conversations through the single owner.
///
/// `None` only when the host cannot name the session's cwd — "cannot say",
/// which the units report as `unavailable`, never as an empty list.
pub async fn resolve(context: &dyn SessionContext, session_id: &str) -> Option<ResolvedSession> {
    let cwd = context.session_cwd(session_id).await?;

    let binding = context.session_claude_binding(session_id).await;
    let history = context
        .session_claude_history(session_id)
        .await
        .unwrap_or_default();
    let verified = context
        .session_claude_verified_conversation(session_id)
        .await;

    // D3: a report is only evidence once its identity resolves to a real
    // transcript. The claimed path is reconciled, not trusted.
    let resolve_report = |report: &Binding| {
        conversation::resolve_by_identity(
            &report.claude_session_id,
            Some(&report.transcript_path),
            &report.cwd,
        )
    };

    // D2/SC-10: the freshest reported evidence is current. The live verified
    // observation outranks the lifecycle file (a hook can lag a /clear or a
    // resume); the latest lifecycle report outranks the history's tail.
    let current = verified
        .as_deref()
        .and_then(|id| conversation::resolve_by_identity(id, None, &cwd))
        .or_else(|| binding.as_ref().and_then(resolve_report))
        .or_else(|| history.last().and_then(resolve_report));

    // D4: the union. Candidates keep the strict cwd rule; the reported set is
    // exactly this session instance's evidence, deduped by identity.
    let mut conversations = conversation::conversations_at(&cwd);
    let mut reported_extras: Vec<Discovered> = Vec::new();
    let mut push_reported = |resolved: Discovered, conversations: &mut Vec<Discovered>| {
        if conversations
            .iter()
            .any(|c| c.claude_session_id == resolved.claude_session_id)
        {
            return;
        }
        if !reported_extras
            .iter()
            .any(|c| c.claude_session_id == resolved.claude_session_id)
        {
            reported_extras.push(resolved.clone());
        }
        conversations.push(resolved);
    };
    if let Some(resolved) = binding.as_ref().and_then(resolve_report) {
        push_reported(resolved, &mut conversations);
    }
    for report in &history {
        if let Some(resolved) = resolve_report(report) {
            push_reported(resolved, &mut conversations);
        }
    }
    if let Some(resolved) = current.clone() {
        push_reported(resolved, &mut conversations);
    }
    conversations.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Some(ResolvedSession {
        cwd,
        conversations,
        current,
        reported_extras,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation::ProjectsRootForTest;
    use async_trait::async_trait;
    use std::path::PathBuf;

    /// A host answering from fixed facts — the resolution owner's inputs.
    struct FixtureHost {
        cwd: Option<String>,
        binding: Option<Binding>,
        history: Option<Vec<Binding>>,
        verified: Option<String>,
    }

    #[async_trait]
    impl SessionContext for FixtureHost {
        async fn session_cwd(&self, _: &str) -> Option<String> {
            self.cwd.clone()
        }
        async fn session_claude_config(
            &self,
            _: &str,
        ) -> Option<crate::session_context::SessionClaudeConfig> {
            None
        }
        async fn session_claude_active(&self, _: &str) -> Option<bool> {
            None
        }
        async fn session_claude_binding(&self, _: &str) -> Option<Binding> {
            self.binding.clone()
        }
        async fn session_claude_history(&self, _: &str) -> Option<Vec<Binding>> {
            self.history.clone()
        }
        async fn session_claude_verified_conversation(&self, _: &str) -> Option<String> {
            self.verified.clone()
        }
    }

    fn report(id: &str, path: PathBuf, cwd: &str, event: &str) -> Binding {
        crate::binding::parse(
            &serde_json::json!({
                "session_id": id,
                "transcript_path": path.to_string_lossy(),
                "cwd": cwd,
                "hook_event_name": event,
            })
            .to_string(),
        )
        .expect("fixture report parses")
    }

    /// One project directory holding `(id, recorded cwd, timestamp)` transcripts.
    fn projects(files: &[(&str, &str, &str)]) -> (tempfile::TempDir, ProjectsRootForTest) {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("-p");
        std::fs::create_dir_all(&project).unwrap();
        for (id, cwd, ts) in files {
            std::fs::write(
                project.join(format!("{id}.jsonl")),
                format!(
                    "{{\"type\":\"user\",\"uuid\":\"u\",\"timestamp\":\"{ts}\",\"cwd\":\"{cwd}\",\"sessionId\":\"{id}\",\"message\":{{\"role\":\"user\",\"content\":\"hi\"}}}}\n"
                ),
            )
            .unwrap();
        }
        let guard = ProjectsRootForTest::set(root.path().to_path_buf());
        (root, guard)
    }

    #[tokio::test]
    async fn a_host_that_cannot_name_the_cwd_resolves_nothing() {
        let host = FixtureHost {
            cwd: None,
            binding: None,
            history: None,
            verified: None,
        };
        assert!(resolve(&host, "agent:s").await.is_none());
    }

    #[tokio::test]
    async fn unreported_candidates_keep_the_strict_cwd_rule() {
        // The negative half of D1: a transcript whose recorded cwd differs and
        // which no report names is not listed, however nearby its directory.
        let (_root, _guard) = projects(&[
            ("mine", "/w", "2026-11-17T00:00:01Z"),
            ("drifted", "/elsewhere", "2026-11-17T00:00:09Z"),
        ]);
        let host = FixtureHost {
            cwd: Some("/w".into()),
            binding: None,
            history: None,
            verified: None,
        };
        let resolved = resolve(&host, "agent:s").await.expect("cwd known");
        let ids: Vec<&str> = resolved
            .conversations
            .iter()
            .map(|c| c.claude_session_id.as_str())
            .collect();
        assert_eq!(ids, vec!["mine"]);
        assert!(resolved.current.is_none());
    }

    #[tokio::test]
    async fn a_reported_drifted_conversation_is_listed_and_current() {
        // SC-01's core: pane cwd /w, transcript head cwd /elsewhere, a
        // SessionStart report naming it. The claim's path does not exist —
        // the measured resume shape — and identity resolution reconciles it.
        let (root, _guard) = projects(&[("conv-1", "/elsewhere", "2026-11-17T00:00:09Z")]);
        let claimed = root.path().join("-drifted").join("conv-1.jsonl");
        let host = FixtureHost {
            cwd: Some("/w".into()),
            binding: Some(report("conv-1", claimed, "/elsewhere", "SessionStart")),
            history: None,
            verified: None,
        };
        let resolved = resolve(&host, "agent:s").await.expect("cwd known");
        assert_eq!(resolved.conversations.len(), 1);
        assert_eq!(resolved.conversations[0].claude_session_id, "conv-1");
        assert_eq!(resolved.conversations[0].cwd, "/elsewhere");
        assert_eq!(
            resolved
                .current
                .as_ref()
                .map(|c| c.claude_session_id.as_str()),
            Some("conv-1")
        );
    }

    #[tokio::test]
    async fn the_verified_observation_outranks_a_lagging_lifecycle_report() {
        // SC-10: the live self-report is the freshest evidence; a hook file
        // still naming the previous conversation must not hide it.
        let (root, _guard) = projects(&[
            ("old", "/w", "2026-11-17T00:00:01Z"),
            ("new", "/w", "2026-11-17T00:00:09Z"),
        ]);
        let host = FixtureHost {
            cwd: Some("/w".into()),
            binding: Some(report(
                "old",
                root.path().join("-p").join("old.jsonl"),
                "/w",
                "SessionStart",
            )),
            history: None,
            verified: Some("new".into()),
        };
        let resolved = resolve(&host, "agent:s").await.expect("cwd known");
        assert_eq!(
            resolved
                .current
                .as_ref()
                .map(|c| c.claude_session_id.as_str()),
            Some("new")
        );
        assert!(resolved
            .conversations
            .iter()
            .any(|c| c.claude_session_id == "old"));
    }

    #[tokio::test]
    async fn history_reports_stay_listed_after_their_cwd_drifted() {
        // SC-04: a prior SessionEnd conversation whose cwd drifted is still
        // this session's conversation; the binding names only the latest.
        let (root, _guard) = projects(&[
            ("earlier", "/gone", "2026-11-17T00:00:01Z"),
            ("latest", "/w", "2026-11-17T00:00:09Z"),
        ]);
        let p = root.path().join("-p");
        let host = FixtureHost {
            cwd: Some("/w".into()),
            binding: Some(report(
                "latest",
                p.join("latest.jsonl"),
                "/w",
                "SessionStart",
            )),
            history: Some(vec![
                report("earlier", p.join("earlier.jsonl"), "/gone", "SessionStart"),
                report("earlier", p.join("earlier.jsonl"), "/gone", "SessionEnd"),
                report("latest", p.join("latest.jsonl"), "/w", "SessionStart"),
            ]),
            verified: None,
        };
        let resolved = resolve(&host, "agent:s").await.expect("cwd known");
        let ids: Vec<&str> = resolved
            .conversations
            .iter()
            .map(|c| c.claude_session_id.as_str())
            .collect();
        assert_eq!(ids, vec!["latest", "earlier"], "newest-first, deduped");
        assert_eq!(
            resolved
                .current
                .as_ref()
                .map(|c| c.claude_session_id.as_str()),
            Some("latest")
        );
    }

    #[tokio::test]
    async fn an_unresolvable_report_contributes_nothing() {
        // SC-03's negative half: no claimed file, no identity match — the
        // report is not a binding, and nothing is invented for it.
        let (_root, _guard) = projects(&[("mine", "/w", "2026-11-17T00:00:01Z")]);
        let host = FixtureHost {
            cwd: Some("/w".into()),
            binding: Some(report(
                "ghost",
                PathBuf::from("/nonexistent/ghost.jsonl"),
                "/w",
                "SessionStart",
            )),
            history: None,
            verified: Some("also-ghost".into()),
        };
        let resolved = resolve(&host, "agent:s").await.expect("cwd known");
        let ids: Vec<&str> = resolved
            .conversations
            .iter()
            .map(|c| c.claude_session_id.as_str())
            .collect();
        assert_eq!(ids, vec!["mine"]);
        assert!(resolved.current.is_none());
    }

    #[tokio::test]
    async fn transcripts_reach_a_drifted_reported_primarys_sidechains() {
        // SC-02/D7: the transcript list includes the reported primary and its
        // subagents, while an unreported drifted transcript stays out.
        let (root, _guard) = projects(&[
            ("conv-1", "/elsewhere", "2026-11-17T00:00:09Z"),
            ("stranger", "/elsewhere", "2026-11-17T00:00:01Z"),
        ]);
        let subagents = root.path().join("-p").join("conv-1").join("subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        std::fs::write(
            subagents.join("agent-abc.jsonl"),
            r#"{"type":"assistant","uuid":"a","isSidechain":true,"timestamp":"2026-11-17T00:00:10Z","cwd":"/elsewhere","sessionId":"conv-1","message":{"role":"assistant","content":"work"}}"#,
        )
        .unwrap();
        let host = FixtureHost {
            cwd: Some("/w".into()),
            binding: Some(report(
                "conv-1",
                root.path().join("-p").join("conv-1.jsonl"),
                "/elsewhere",
                "SessionStart",
            )),
            history: None,
            verified: None,
        };
        let resolved = resolve(&host, "agent:s").await.expect("cwd known");
        let transcripts = resolved.transcripts();
        let ids: Vec<&str> = transcripts
            .iter()
            .map(|t| t.claude_session_id.as_str())
            .collect();
        assert_eq!(ids, vec!["conv-1/agent-abc", "conv-1"]);
    }
}
