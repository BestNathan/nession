//! The host side of the Claude Code capability's session boundary (#1005).
//!
//! `nession-claude-code` declares what it needs ([`SessionContext`]); this is
//! the only thing that can answer, because the agent is what owns session
//! lifecycle and addresses tmux.
//!
//! ## The session id is normalised the same way git's resolver normalises it
//!
//! [`extract_session_name`] turns `agent:name` into `name`, and
//! `git_workdir.rs` uses it for exactly this. Using it here too is not tidiness:
//! if this file normalised differently, a conversation request and a git request
//! carrying the same id would address *different sessions*, and the capability
//! would show one session's Claude conversation beside another's repository —
//! both answers individually plausible.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use nession_claude_code::binding::Binding;
use nession_claude_code::session_context::{SessionClaudeConfig, SessionContext};

use crate::server::websocket::extract_session_name;
use crate::tmux::manager::{SessionManager, INSTANCE_ID_ENV};

/// Answers from the agent's own tmux addressing.
pub struct TmuxSessionContext {
    tmux: Arc<SessionManager>,
    /// Root the binding files live in; `None` is the Agent's own state
    /// directory. Tests own a temporary root, the same way
    /// [`SessionMetadataStore::with_root`](crate::session::metadata::SessionMetadataStore::with_root)
    /// gives them one for metadata.
    binding_root: Option<PathBuf>,
}

impl TmuxSessionContext {
    pub fn new(tmux: Arc<SessionManager>) -> Self {
        Self {
            tmux,
            binding_root: None,
        }
    }

    /// A context that reads binding files under `root`, for tests and owned
    /// fixtures. Production reads the Agent's state directory.
    pub fn with_binding_root(tmux: Arc<SessionManager>, root: PathBuf) -> Self {
        Self {
            tmux,
            binding_root: Some(root),
        }
    }

    /// The file this Session's hook was told to write (`#2974`).
    ///
    /// A Session created since the instance fence carries [`INSTANCE_ID_ENV`],
    /// delivered by the create that also used that id to build the hook's path;
    /// the durable tmux option is what makes the same id available after an
    /// Agent restart. A Session that predates the fence has no such variable —
    /// it was handed the name-derived path and its hook keeps writing there for
    /// the rest of its life — so that is the file read for it. The variable is
    /// therefore the compatibility marker, not a convenience: it is what lets a
    /// fenced Session treat "no binding" as an answer instead of falling back to
    /// a file a deleted Session may have left behind.
    async fn binding_file(&self, name: &str) -> Option<PathBuf> {
        match self.tmux.get_session_env(name, INSTANCE_ID_ENV).await {
            Ok(Some(_)) => {
                let instance = match self.tmux.session_instance_id(name).await {
                    Ok(instance) => instance,
                    Err(err) => {
                        tracing::debug!(
                            session = %name,
                            error = %err,
                            "claude-code: session instance unavailable"
                        );
                        return None;
                    }
                };
                match &self.binding_root {
                    Some(root) => Some(crate::claude_binding::file_for_in(root, name, &instance)),
                    None => crate::claude_binding::file_for(name, &instance),
                }
            }
            Ok(None) => match &self.binding_root {
                Some(root) => Some(crate::claude_binding::legacy_file_for_in(root, name)),
                None => crate::claude_binding::legacy_file_for(name),
            },
            Err(err) => {
                tracing::debug!(
                    session = %name,
                    variable = %INSTANCE_ID_ENV,
                    error = %err,
                    "claude-code: session environment unavailable"
                );
                None
            }
        }
    }

    /// One observed variable, or `None` when the question could not be asked.
    ///
    /// A missing variable is `Some(None)`: that is an observation. An error is
    /// the host having no answer at all, which the memory resolver reports as
    /// an unsupported override rather than reading defaults.
    async fn session_var(&self, session: &str, name: &str) -> Option<Option<String>> {
        match self.tmux.get_session_env(session, name).await {
            Ok(value) => Some(value),
            Err(err) => {
                tracing::debug!(
                    session = %session,
                    variable = %name,
                    error = %err,
                    "claude-code: session environment unavailable"
                );
                None
            }
        }
    }
}

/// The command names that mean "Claude Code is running here".
///
/// `claude.exe` is in the list because a real Claude Code install reports that
/// on some platforms — the Web projection already recognises both, and this
/// must agree with it rather than form a second opinion.
const CLAUDE_COMMANDS: [&str; 2] = ["claude", "claude.exe"];

#[async_trait]
impl SessionContext for TmuxSessionContext {
    /// The session's working directory, as tmux reports it.
    ///
    /// `None` rather than an error for every way this can fail: the session may
    /// have exited between the request and this call, the tmux server may be
    /// gone, or the id may name a session this agent never had. All of those
    /// mean "cannot say", and `#1005` requires that to be reported rather than
    /// guessed at — a wrong cwd would silently produce another session's
    /// conversation.
    async fn session_cwd(&self, session_id: &str) -> Option<String> {
        let name = extract_session_name(session_id);
        if name.is_empty() {
            return None;
        }
        match self.tmux.get_session_cwd(&name).await {
            Ok(path) if !path.trim().is_empty() => Some(path.trim().to_string()),
            Ok(_) => None,
            Err(err) => {
                tracing::debug!(session = %name, error = %err, "claude-code: session cwd unavailable");
                None
            }
        }
    }

    /// The Session's Claude Code environment, observed through tmux (#2689).
    ///
    /// The values come from the Session's own tmux environment, not from this
    /// agent process: an agent started under one `CLAUDE_CONFIG_DIR` may serve
    /// sessions that set another, and reading the process environment would
    /// resolve the wrong Memory directory. All five queries must succeed to
    /// return `Some`; one unanswerable variable makes the effective location
    /// unverifiable, which is a distinct answer rather than "unset".
    async fn session_claude_config(&self, session_id: &str) -> Option<SessionClaudeConfig> {
        let name = extract_session_name(session_id);
        if name.is_empty() {
            return None;
        }

        Some(SessionClaudeConfig {
            home: self.session_var(&name, "HOME").await?,
            config_dir: self.session_var(&name, "CLAUDE_CONFIG_DIR").await?,
            project_dir_name: self
                .session_var(&name, "CLAUDE_CODE_PROJECT_DIR_NAME")
                .await?,
            memory_path_override: self
                .session_var(&name, "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE")
                .await?,
            remote_memory_dir: self
                .session_var(&name, "CLAUDE_CODE_REMOTE_MEMORY_DIR")
                .await?,
        })
    }

    /// Whether Claude Code is the pane's foreground command right now.
    ///
    /// No pane answer is `None`, not `false`: "Claude is not running" and "this
    /// agent cannot see the pane" are different claims, and only the first is
    /// safe to show a user as "this conversation is finished".
    async fn session_claude_active(&self, session_id: &str) -> Option<bool> {
        let name = extract_session_name(session_id);
        if name.is_empty() {
            return None;
        }
        match self.tmux.get_session_command(&name).await {
            Ok(command) => {
                let base = command.trim();
                Some(CLAUDE_COMMANDS.contains(&base))
            }
            Err(err) => {
                tracing::debug!(session = %name, error = %err, "claude-code: session command unavailable");
                None
            }
        }
    }

    /// The binding this session's Claude reported, read from the agent's own
    /// state directory.
    ///
    /// The path comes from [`Self::binding_file`], which resolves the file the
    /// hook was actually handed — see that method and [`claude_binding`] for why
    /// the derivation is shared rather than repeated. The session id is
    /// normalised the same way every other lookup here normalises it, so a
    /// request naming `agent:s` reads the binding filed under `s`.
    ///
    /// Nothing is created here. A missing file is the ordinary state for a
    /// session whose Claude has not started, so this is a read on a path that
    /// usually does not exist yet — and it must not be the thing that creates
    /// the directory, because the answer to "is it there" would then always be
    /// yes.
    async fn session_claude_binding(&self, session_id: &str) -> Option<Binding> {
        let name = extract_session_name(session_id);
        if name.is_empty() {
            return None;
        }
        let path = self.binding_file(&name).await?;

        // A small file read, but still file I/O on an async worker — the same
        // treatment every other blocking read in this crate gets.
        match tokio::task::spawn_blocking(move || nession_claude_code::binding::read(&path)).await {
            Ok(binding) => binding,
            Err(err) => {
                tracing::debug!(session = %name, error = %err, "claude-code: binding read task failed");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_recognised_command_names_are_the_ones_the_web_projection_uses() {
        // Pinned together on purpose: if the projection learns a third spelling
        // and this does not, the terminal would say Claude is running while the
        // conversation said it had stopped.
        assert!(CLAUDE_COMMANDS.contains(&"claude"));
        assert!(CLAUDE_COMMANDS.contains(&"claude.exe"));
    }

    #[tokio::test]
    async fn an_id_with_no_session_name_resolves_to_nothing() {
        // `extract_session_name("")` is empty, and asking tmux for the empty
        // session name would address something rather than nothing.
        let context = TmuxSessionContext::new(Arc::new(SessionManager::new()));
        assert_eq!(context.session_cwd("").await, None);
        assert_eq!(context.session_claude_active("").await, None);
        assert_eq!(context.session_claude_config("").await, None);
    }

    #[tokio::test]
    async fn an_unanswerable_session_environment_is_none_rather_than_all_unset() {
        // The memory resolver must be able to tell "this Session's variables
        // are unset" from "tmux would not answer" (#2689). A session this
        // manager does not have is the second case.
        let context = TmuxSessionContext::new(Arc::new(SessionManager::new()));
        assert_eq!(context.session_claude_config("agent:missing").await, None);
    }

    // ------------------------------------------------------------------
    // The Claude binding lifecycle fence (#2974)
    //
    // These run a real tmux server, like the metadata suite (#2789): the
    // property is the tmux Session instance's, so a fake would be asserting
    // the fixture. The Case owns the socket and the state directory.
    // ------------------------------------------------------------------

    fn tmux_available() -> bool {
        // Through the canonical chokepoint, like every tmux call; `-V` needs
        // no server, so it is harmless on the private socket.
        crate::tmux::cmd::global()
            .std()
            .arg("-V")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    struct BindingFixture {
        /// Kept alive for the files written under it. Declared first so it
        /// outlives every read the fixture's context makes.
        root: tempfile::TempDir,
        tmux: Arc<SessionManager>,
        session: crate::test_support::TestSession,
        context: TmuxSessionContext,
    }

    async fn binding_fixture(prefix: &str) -> BindingFixture {
        let root = tempfile::tempdir().expect("the fixture owns a temporary binding root");
        let tmux = Arc::new(SessionManager::new());
        let session = crate::test_support::TestSession::new(prefix);
        tmux.create_session(session.name(), 80, 24, "/tmp", &[])
            .await
            .expect("the fixture creates its tmux Session");
        let context =
            TmuxSessionContext::with_binding_root(Arc::clone(&tmux), root.path().to_path_buf());
        BindingFixture {
            root,
            tmux,
            session,
            context,
        }
    }

    /// The instance id the create delivered to the Session's environment.
    ///
    /// Read from the environment rather than `session_instance_id` on purpose:
    /// this is what the hook was handed, and the test must not initialize the
    /// durable option before the reader under test does.
    async fn delivered_instance(tmux: &SessionManager, name: &str) -> String {
        tmux.get_session_env(name, INSTANCE_ID_ENV)
            .await
            .expect("the Session environment is readable")
            .expect("the create delivers an instance id")
    }

    /// A real hook payload shape: what Claude sends on stdin and the hook
    /// copies verbatim.
    fn hook_payload(conversation: &str) -> String {
        format!(
            r#"{{"session_id":"{conversation}","transcript_path":"/tmp/{conversation}.jsonl","cwd":"/tmp","hook_event_name":"SessionStart"}}"#
        )
    }

    #[tokio::test]
    async fn a_recreated_session_of_the_same_name_does_not_inherit_the_deleted_sessions_binding() {
        if !tmux_available() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let fixture = binding_fixture("claude-binding-recreate").await;
        let name = fixture.session.name().to_string();

        // A's hook writes the file its environment named.
        let old_instance = delivered_instance(&fixture.tmux, &name).await;
        let old_path =
            crate::claude_binding::file_for_in(fixture.root.path(), &name, &old_instance);
        std::fs::write(&old_path, hook_payload("conversation-a"))
            .expect("the fixture writes A's hook payload");
        let bound = fixture
            .context
            .session_claude_binding(&name)
            .await
            .expect("A's own binding resolves");
        assert_eq!(bound.claude_session_id, "conversation-a");

        // Delete A and recreate the same name: a new tmux Session instance.
        fixture.tmux.kill_session(&name).await.expect("kill A");
        fixture
            .tmux
            .create_session(&name, 80, 24, "/tmp", &[])
            .await
            .expect("recreate B");
        let new_instance = delivered_instance(&fixture.tmux, &name).await;
        assert_ne!(
            new_instance, old_instance,
            "a recreate is a new tmux Session instance"
        );

        assert_eq!(
            fixture.context.session_claude_binding(&name).await,
            None,
            "B must not inherit A's conversation before B's own hook runs"
        );

        // A `SessionEnd` hook from the deleted instance can still be finishing.
        // It writes the path its environment named — A's file.
        std::fs::write(&old_path, hook_payload("conversation-a-late"))
            .expect("the fixture simulates A's delayed hook write");
        assert_eq!(
            fixture.context.session_claude_binding(&name).await,
            None,
            "a late write from the deleted instance must not bind B"
        );

        // B's own hook binds B.
        let new_path =
            crate::claude_binding::file_for_in(fixture.root.path(), &name, &new_instance);
        std::fs::write(&new_path, hook_payload("conversation-b"))
            .expect("the fixture writes B's hook payload");
        let bound = fixture
            .context
            .session_claude_binding(&name)
            .await
            .expect("B's own hook binds B");
        assert_eq!(bound.claude_session_id, "conversation-b");
    }

    #[tokio::test]
    async fn an_agent_restart_preserves_the_binding_of_the_surviving_tmux_instance() {
        if !tmux_available() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let fixture = binding_fixture("claude-binding-restart").await;
        let name = fixture.session.name().to_string();

        let instance = delivered_instance(&fixture.tmux, &name).await;
        let path = crate::claude_binding::file_for_in(fixture.root.path(), &name, &instance);
        std::fs::write(&path, hook_payload("conversation-a"))
            .expect("the fixture writes the hook payload");

        // The Agent restart shape: a fresh manager over the same tmux Session.
        // The binding survives only if the restarted reader derives the same
        // instance-fenced path the create handed the hook.
        let restarted_tmux = Arc::new(SessionManager::new());
        let restarted = TmuxSessionContext::with_binding_root(
            Arc::clone(&restarted_tmux),
            fixture.root.path().to_path_buf(),
        );
        let bound = restarted
            .session_claude_binding(&name)
            .await
            .expect("the surviving tmux instance keeps its valid binding");
        assert_eq!(bound.claude_session_id, "conversation-a");
        assert_eq!(
            restarted_tmux
                .session_instance_id(&name)
                .await
                .expect("the restart can read the instance identity"),
            instance,
            "the restart resolved the same instance identity the create delivered"
        );

        // The negative half of the criterion: delete that instance, recreate
        // the name, and let the deleted instance's hook write late.
        restarted_tmux.kill_session(&name).await.expect("kill");
        restarted_tmux
            .create_session(&name, 80, 24, "/tmp", &[])
            .await
            .expect("recreate the name");
        std::fs::write(&path, hook_payload("conversation-a-late"))
            .expect("the fixture simulates the deleted instance's late write");
        assert_eq!(
            restarted.session_claude_binding(&name).await,
            None,
            "a deleted instance's late write cannot bind a newer same-name Session"
        );
    }

    #[tokio::test]
    async fn a_session_created_before_the_fence_still_reads_its_name_derived_binding() {
        if !tmux_available() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let fixture = binding_fixture("claude-binding-legacy").await;
        let name = fixture.session.name().to_string();

        // A Session created by an Agent that predates #2974 was handed the
        // name-derived path and its hook keeps writing there for the rest of
        // its life. Removing the marker models exactly the input the reader
        // sees for such a Session; the upgrade must not lose a valid binding.
        fixture
            .tmux
            .env()
            .tmux()
            .ops()
            .unset_environment(&name, INSTANCE_ID_ENV)
            .await
            .expect("the fixture can model a pre-fence Session");
        let legacy = crate::claude_binding::legacy_file_for_in(fixture.root.path(), &name);
        std::fs::write(&legacy, hook_payload("conversation-legacy"))
            .expect("the fixture writes the pre-fence hook payload");

        let bound = fixture
            .context
            .session_claude_binding(&name)
            .await
            .expect("a Session created before the fence keeps its valid binding");
        assert_eq!(bound.claude_session_id, "conversation-legacy");
    }

    #[tokio::test]
    async fn a_fenced_session_ignores_a_stale_pre_fence_file() {
        if !tmux_available() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let fixture = binding_fixture("claude-binding-stale-legacy").await;
        let name = fixture.session.name().to_string();

        // A deleted pre-fence Session of this name left its name-derived file
        // behind — kill_session deliberately does not remove binding files.
        // This is the exact state a new same-name Session must not read.
        let legacy = crate::claude_binding::legacy_file_for_in(fixture.root.path(), &name);
        std::fs::write(&legacy, hook_payload("stale-pre-fence"))
            .expect("the fixture leaves a stale pre-fence file");

        assert_eq!(
            fixture.context.session_claude_binding(&name).await,
            None,
            "a fenced Session must not read a pre-fence file, stale or not"
        );

        // Its own hook's file is still the one that binds it.
        let instance = delivered_instance(&fixture.tmux, &name).await;
        let fenced = crate::claude_binding::file_for_in(fixture.root.path(), &name, &instance);
        std::fs::write(&fenced, hook_payload("conversation-current"))
            .expect("the fixture writes the fenced hook payload");
        let bound = fixture
            .context
            .session_claude_binding(&name)
            .await
            .expect("the fenced file binds the Session");
        assert_eq!(bound.claude_session_id, "conversation-current");
    }
}
