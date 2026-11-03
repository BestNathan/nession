//! Session Environment Binding materialization and shell convergence (#170).
//!
//! A Session owns exactly one Environment Binding. The binding has three
//! runtime layers, and this module keeps them apart:
//!
//! * **Layer A — creation.** `SessionManager::create_session_with_binding`
//!   resolves the ordered profile snapshots and passes the effective
//!   environment to `tmux new-session -e`, so the initial process starts with
//!   it.
//! * **Layer B — future panes/windows.** [`EnvManager::apply_binding`] writes
//!   the binding into tmux's Session environment with `set-environment`, and
//!   restores the captured base value (or unsets) for keys the binding stops
//!   managing.
//! * **Layer C — the already-running interactive shell.** A Session-local shell
//!   adapter sources a generated overlay at the next prompt. It never uses
//!   `send-keys`, never evals the whole tmux environment, and never edits the
//!   user's global rc files.
//!
//! ## Durable state and secrets
//!
//! The Agent must know, after its own restart, which keys a binding manages and
//! what each key's base value was; otherwise it would either lose the ability
//! to restore a value or blindly unset a key the shell already had. That state
//! lives beside the Session's overlay under `<agent>/env-bindings/<session>/`,
//! in files mode `0600` inside a directory mode `0700`.
//!
//! **This is a plaintext copy of the base values the binding overrides, and it
//! can contain secrets.** The generated `env-runtime.sh` is likewise a
//! plaintext copy of the managed overlay (the shell has to source it). Both are
//! scoped to the Agent's own state directory, are never sent on the wire, and
//! exist so removal can restore `MODE=default` rather than silently unsetting
//! it. The alternative — not persisting a baseline — trades a secret copy for
//! incorrect restoration after an Agent restart. This consequence is stated in
//! `docs/architecture/session-env-binding.md`; do not add another durable copy
//! without updating that owner.

use anyhow::{Context, Result};
use nession_protocol::contracts::env::v1::{
    EnvFileRef, EnvSnapshot, SessionEnvObservedState, SessionEnvProfile,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use tokio::fs;

use super::ops::TmuxDep;

/// The overlay script the interactive shell sources. It contains only the
/// operations needed to converge the keys this binding manages.
const ENV_RUNTIME_FILE: &str = "env-runtime.sh";
/// The revision the overlay represents. The adapter reads it before sourcing.
const ENV_REVISION_FILE: &str = "revision";
/// The revision the shell last reported converging to, written by the adapter.
const SHELL_REVISION_FILE: &str = "shell-revision";
/// The Agent's durable record for one Session's materialization.
const BINDING_STATE_FILE: &str = "binding.json";

const ENV_RUNTIME_VAR: &str = "NESSON_ENV_RUNTIME";
const ENV_REVISION_VAR: &str = "NESSON_ENV_REVISION";
const SHELL_REVISION_VAR: &str = "NESSON_ENV_SHELL_REVISION";
const USER_ZDOTDIR_VAR: &str = "NESSON_USER_ZDOTDIR";

const STATUS_IN_SYNC: &str = "in_sync";
const STATUS_PENDING_SHELL: &str = "pending_shell";
const STATUS_UNSUPPORTED_SHELL: &str = "unsupported_shell";
const STATUS_ERROR: &str = "error";

/// Clear a session's scrollback, hiding a line the caller just printed.
///
/// **BestEffort**: a failure does not change the primary operation's result,
/// but it is logged because an unobservable failure is a policy nobody chose.
/// The only remaining caller is `SessionManager`'s create fallback, which
/// hides the typed environment line.
pub(crate) async fn clear_history(tmux: &TmuxDep, session_name: &str) {
    tmux.ops().clear_history(session_name).await;
}

/// Build profile refs from snapshots for a legacy caller that only knows
/// snapshots (`env_snapshots` on attach/create).
///
/// The snapshot carries the same `(name, source, agent_id)` identity as
/// [`EnvFileRef`], so no profile is invented — the ref is read from the content
/// the caller already resolved.
pub(crate) fn profiles_from_snapshots(
    snapshots: &[EnvSnapshot],
    phase: &str,
) -> Vec<SessionEnvProfile> {
    snapshots
        .iter()
        .map(|snapshot| SessionEnvProfile {
            profile: EnvFileRef {
                name: snapshot.name.clone(),
                source: snapshot.source,
                agent_id: snapshot.agent_id.clone(),
            },
            phase: phase.to_string(),
            content_hash: None,
        })
        .collect()
}

/// The merged effective overlay of an ordered profile selection.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct EffectiveOverlay {
    /// Ordered key/value pairs; a later profile wins.
    pub vars: Vec<(String, String)>,
    /// Non-fatal reasons a profile entry was ignored.
    pub warnings: Vec<String>,
}

/// The Session-local shell adapter this Agent installed, if any.
#[derive(Debug, Clone)]
pub(crate) struct ShellAdapter {
    /// The shell the adapter targets (`bash`, `zsh`), when one was recognized.
    pub shell: Option<String>,
    /// Environment entries the adapter needs in the Session.
    pub env: Vec<(String, String)>,
    /// Process argv to run instead of tmux's default command. Empty for zsh,
    /// whose adapter is selected by `ZDOTDIR` alone.
    pub command: Vec<String>,
    /// Whether the adapter can converge the current interactive shell.
    pub supported: bool,
    /// Why it cannot, when it cannot.
    pub reason: Option<String>,
}

impl ShellAdapter {
    pub(crate) fn unsupported(shell: Option<String>, reason: impl Into<String>) -> Self {
        Self {
            shell,
            env: Vec::new(),
            command: Vec::new(),
            supported: false,
            reason: Some(reason.into()),
        }
    }
}

/// The durable half of a Session's binding, written after every materialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredBinding {
    session_name: String,
    applied_revision: u64,
    profiles: Vec<StoredProfile>,
    /// For every key the binding manages, what tmux held before Nession began
    /// managing it. `None` means it was absent.
    baseline: BTreeMap<String, Option<String>>,
    shell: Option<String>,
    adapter: bool,
    /// Why no Session-local shell adapter was installed. Informational: an
    /// unsupported shell is a real state, not a failed tmux mutation, so this
    /// must not be read as an error.
    #[serde(default)]
    adapter_reason: Option<String>,
    status: String,
    /// The last tmux mutation failure. Never the adapter's explanation.
    last_error: Option<String>,
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredProfile {
    profile: EnvFileRef,
    phase: String,
}

/// What one binding materialization produced, for the caller's reply.
#[derive(Debug, Clone)]
pub(crate) struct BindingApplyOutcome {
    pub warnings: Vec<String>,
    pub observed: SessionEnvObservedState,
}

/// Manages Session Environment Bindings and their tmux/process materialization.
pub struct EnvManager {
    /// Root of the durable per-Session state. `0700` in production.
    state_dir: PathBuf,
    /// The tmux everything this manager runs is addressed to.
    tmux: TmuxDep,
}

impl EnvManager {
    /// Create an `EnvManager` whose per-Session state lives under `state_dir`.
    pub fn new(state_dir: PathBuf) -> Self {
        Self {
            state_dir,
            tmux: TmuxDep::global(),
        }
    }

    /// Bind this manager to a specific tmux dependency — **the substitution
    /// seam**. See `SessionManager::with_tmux_cmd`.
    pub fn with_tmux(&mut self, tmux: TmuxDep) -> &mut Self {
        self.tmux = tmux;
        self
    }

    /// Move the durable per-Session state to `state_dir`. Production uses the
    /// Agent's own directory; tests use a temporary one.
    pub fn with_state_dir(mut self, state_dir: PathBuf) -> Self {
        self.state_dir = state_dir;
        self
    }

    /// The tmux dependency this manager runs on.
    pub fn tmux(&self) -> &TmuxDep {
        &self.tmux
    }

    /// The durable state root, for the caller that has to create it.
    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    /// Set tmux-level environment variables on a running session.
    ///
    /// One [`TmuxOps::set_environment`] per variable. Every variable is
    /// attempted (one bad name must not hide the rest), and any failure is an
    /// error carrying tmux's own stderr.
    pub async fn set_environment(
        &self,
        session_name: &str,
        vars: &[(String, String)],
    ) -> Result<()> {
        let ops = self.tmux.ops();
        let mut failures: Vec<String> = Vec::new();
        for (key, value) in vars {
            if let Err(e) = ops.set_environment(session_name, key, value).await {
                failures.push(format!("{e:#}"));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(anyhow::anyhow!("{}", failures.join("; ")))
        }
    }

    /// Merge ordered snapshots into the effective overlay. A later profile
    /// wins; keys Nession reserves are refused with a warning, never silently
    /// applied. A key that is not a valid shell variable name is an error:
    /// it cannot be exported, and answering success would claim a mutation the
    /// shell can never observe.
    pub(crate) fn merge_snapshots(snapshots: &[EnvSnapshot]) -> Result<EffectiveOverlay> {
        let mut vars: Vec<(String, String)> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        let mut warnings: Vec<String> = Vec::new();
        let mut refused: HashSet<String> = HashSet::new();

        for snapshot in snapshots {
            for (key, value) in &snapshot.vars {
                if let Some(reason) = reserved_key_reason(key) {
                    if refused.insert(key.clone()) {
                        warnings.push(format!(
                            "{}: {key} is reserved by Nession ({reason}); it was not applied",
                            snapshot.name
                        ));
                    }
                    continue;
                }
                if !is_valid_env_key(key) {
                    anyhow::bail!(
                        "{}: invalid environment variable name {key:?}",
                        snapshot.name
                    );
                }
                if let Some(&existing) = index.get(key) {
                    if let Some(slot) = vars.get_mut(existing) {
                        slot.1 = value.clone();
                    }
                } else {
                    index.insert(key.clone(), vars.len());
                    vars.push((key.clone(), value.clone()));
                }
            }
        }

        Ok(EffectiveOverlay { vars, warnings })
    }

    /// Apply one binding revision to a running Session.
    ///
    /// This is a **whole-binding replacement**: every key in `snapshots` is
    /// managed, every previously managed key that is no longer present is
    /// restored to its captured base value or unset, and the shell overlay is
    /// rewritten. There are no per-file apply/unset calls to compose.
    pub(crate) async fn apply_binding(
        &self,
        session_name: &str,
        revision: u64,
        profiles: &[SessionEnvProfile],
        snapshots: &[EnvSnapshot],
    ) -> Result<BindingApplyOutcome> {
        let overlay = Self::merge_snapshots(snapshots)?;
        let warnings = overlay.warnings.clone();
        let dir = self.session_dir(session_name);
        let mut state = self
            .load_state(session_name)
            .await
            .unwrap_or_else(|| StoredBinding {
                session_name: session_name.to_string(),
                applied_revision: 0,
                profiles: Vec::new(),
                baseline: BTreeMap::new(),
                shell: None,
                adapter: false,
                adapter_reason: None,
                status: STATUS_IN_SYNC.to_string(),
                last_error: None,
                updated_at: now_secs(),
            });

        // Capture the base value of every newly managed key before changing
        // anything. A read failure aborts the whole apply: proceeding would
        // record a baseline we did not observe, and removal would then restore
        // a value nobody measured.
        let mut baseline = state.baseline.clone();
        for (key, _) in &overlay.vars {
            if baseline.contains_key(key) {
                continue;
            }
            let value = self
                .tmux
                .ops()
                .show_environment(session_name, key)
                .await
                .with_context(|| {
                    format!("capturing the base value of {key} for session {session_name}")
                })?;
            baseline.insert(key.clone(), value);
        }

        let new_keys: HashSet<&str> = overlay.vars.iter().map(|(k, _)| k.as_str()).collect();
        let mut failures: Vec<String> = Vec::new();

        for (key, value) in &overlay.vars {
            if let Err(e) = self
                .tmux
                .ops()
                .set_environment(session_name, key, value)
                .await
            {
                failures.push(format!("{e:#}"));
            }
        }

        // Keys this binding no longer manages. Restore what was there before
        // Nession took the key over; do not blindly unset.
        let removed: Vec<String> = baseline
            .keys()
            .filter(|key| !new_keys.contains(key.as_str()))
            .cloned()
            .collect();
        let mut runtime_ops: Vec<(String, Option<String>)> = Vec::new();
        let mut restored_ok: HashSet<String> = HashSet::new();
        for key in &removed {
            let restore = baseline.get(key).cloned().flatten();
            // The shell overlay gets the operation even when the tmux
            // restoration failed: the failure is about future processes, and
            // the current shell can still converge at its next prompt.
            runtime_ops.push((key.clone(), restore.clone()));
            let result = match &restore {
                Some(value) => {
                    self.tmux
                        .ops()
                        .set_environment(session_name, key, value)
                        .await
                }
                None => self.tmux.ops().unset_environment(session_name, key).await,
            };
            match result {
                Ok(()) => {
                    restored_ok.insert(key.clone());
                }
                Err(e) => failures.push(format!("{e:#}")),
            }
        }

        // A key whose restoration failed keeps its baseline so a later binding
        // can still restore it; a key that was restored releases it.
        for key in &restored_ok {
            baseline.remove(key);
        }
        baseline.retain(|key, _| new_keys.contains(key.as_str()));

        // The shell overlay contains only this binding's own operations, plus
        // restoration for keys the previous revision managed. The adapter
        // compares revisions before sourcing it, so an unchanged binding is
        // free.
        self.write_runtime_files(&dir, revision, &overlay, &runtime_ops)
            .await?;

        let shell_revision = read_revision(&dir.join(SHELL_REVISION_FILE)).await;
        let last_error = if failures.is_empty() {
            None
        } else {
            Some(failures.join("; "))
        };
        let status = self.status_for(
            state.adapter,
            revision,
            shell_revision,
            last_error.as_deref(),
        );
        state.applied_revision = revision;
        state.profiles = profiles
            .iter()
            .map(|profile| StoredProfile {
                profile: profile.profile.clone(),
                phase: profile.phase.clone(),
            })
            .collect();
        state.baseline = baseline;
        state.status = status;
        state.last_error = last_error.clone();
        state.updated_at = now_secs();
        self.save_state(session_name, &state).await?;

        // A required tmux mutation that failed is never reported as success.
        // The state above records the failure so a later observe can show it;
        // this is what makes the caller fail too.
        if let Some(error) = last_error {
            return Err(anyhow::anyhow!(error));
        }

        let observed = observed_from(&state, shell_revision);
        Ok(BindingApplyOutcome { warnings, observed })
    }

    /// Record the binding a just-created Session was born with.
    ///
    /// The initial process already has the effective environment (Layer A), so
    /// the shell revision starts at `revision`: there is nothing to converge.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn record_created_binding(
        &self,
        session_name: &str,
        revision: u64,
        profiles: &[SessionEnvProfile],
        overlay: &EffectiveOverlay,
        baseline: BTreeMap<String, Option<String>>,
        adapter: &ShellAdapter,
    ) -> Result<()> {
        let dir = self.session_dir(session_name);
        self.write_runtime_files(&dir, revision, overlay, &[])
            .await?;
        write_atomic(&dir.join(SHELL_REVISION_FILE), format!("{revision}\n")).await?;

        let state = StoredBinding {
            session_name: session_name.to_string(),
            applied_revision: revision,
            profiles: profiles
                .iter()
                .map(|profile| StoredProfile {
                    profile: profile.profile.clone(),
                    phase: profile.phase.clone(),
                })
                .collect(),
            baseline,
            shell: adapter.shell.clone(),
            adapter: adapter.supported,
            adapter_reason: adapter.reason.clone(),
            status: if adapter.supported {
                STATUS_IN_SYNC.to_string()
            } else {
                STATUS_UNSUPPORTED_SHELL.to_string()
            },
            last_error: None,
            updated_at: now_secs(),
        };
        self.save_state(session_name, &state).await
    }

    /// The observed binding state for one Session, or `None` when no binding
    /// was ever recorded (a Session that predates the binding model).
    pub(crate) async fn observe(&self, session_name: &str) -> Option<SessionEnvObservedState> {
        let mut state = self.load_state(session_name).await?;
        let shell_revision =
            read_revision(&self.session_dir(session_name).join(SHELL_REVISION_FILE)).await;
        state.status = self.status_for(
            state.adapter,
            state.applied_revision,
            shell_revision,
            state.last_error.as_deref(),
        );
        Some(observed_from(&state, shell_revision))
    }

    /// The observed state of every Session that has a recorded binding.
    ///
    /// Used after registration so a Server restart does not erase the observed
    /// half of a binding that tmux still holds. States are reported from the
    /// durable record without asking tmux to list Sessions: the Server already
    /// knows its registry, and a stale name is dropped there rather than paying
    /// for a tmux round trip on every reconnect.
    pub(crate) async fn live_binding_states(&self) -> Vec<(String, SessionEnvObservedState)> {
        self.stored_states().await
    }

    /// Every durable binding state on disk, live or stale.
    async fn stored_states(&self) -> Vec<(String, SessionEnvObservedState)> {
        let mut out = Vec::new();
        let mut dir = match fs::read_dir(&self.state_dir).await {
            Ok(dir) => dir,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        "cannot read env binding state dir {}: {e}",
                        self.state_dir.display()
                    );
                }
                return out;
            }
        };
        while let Ok(Some(entry)) = dir.next_entry().await {
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let Some(session_name) =
                read_state_session_name(&entry.path().join(BINDING_STATE_FILE)).await
            else {
                continue;
            };
            if let Some(observed) = self.observe(&session_name).await {
                out.push((session_name, observed));
            }
        }
        out
    }

    /// The revision a locally-created binding should use next.
    pub(crate) async fn next_local_revision(&self, session_name: &str) -> u64 {
        self.load_state(session_name)
            .await
            .map_or(1, |state| state.applied_revision.saturating_add(1))
    }

    /// Remove a Session's durable binding state. Called when the Session is
    /// killed; a state file left behind would describe a Session that no
    /// longer exists.
    pub(crate) async fn clear_session_binding(&self, session_name: &str) {
        let dir = self.session_dir(session_name);
        if let Err(e) = fs::remove_dir_all(&dir).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("failed to remove env binding state {}: {e}", dir.display());
            }
        }
    }

    /// Install the Session-local shell adapter for `shell_path`.
    ///
    /// `bash` and `zsh` are the only shells with a proven adapter. Everything
    /// else degrades explicitly: the binding still materializes into tmux and
    /// future processes, and the observed status says the current shell is not
    /// supported rather than pretending it converged.
    pub(crate) async fn install_shell_adapter(
        &self,
        session_name: &str,
        shell_path: Option<&str>,
    ) -> ShellAdapter {
        let Some(shell_path) = shell_path.filter(|path| !path.is_empty()) else {
            return ShellAdapter::unsupported(None, "tmux reported no default shell");
        };
        let kind = shell_kind(shell_path);
        match kind.as_deref() {
            Some("bash") => match self.install_bash_adapter(session_name, shell_path).await {
                Ok(adapter) => adapter,
                Err(e) => ShellAdapter::unsupported(Some("bash".to_string()), format!("{e:#}")),
            },
            Some("zsh") => match self.install_zsh_adapter(session_name).await {
                Ok(adapter) => adapter,
                Err(e) => ShellAdapter::unsupported(Some("zsh".to_string()), format!("{e:#}")),
            },
            _ => ShellAdapter::unsupported(
                Some(shell_basename(shell_path)),
                format!("no Session-local adapter for shell {shell_path}"),
            ),
        }
    }

    async fn install_bash_adapter(
        &self,
        session_name: &str,
        shell_path: &str,
    ) -> Result<ShellAdapter> {
        let dir = self.session_dir(session_name).join("shell").join("bash");
        secure_dir(&dir).await?;
        let rcfile = dir.join("bashrc");
        write_atomic(&rcfile, BASH_ADAPTER).await?;
        Ok(ShellAdapter {
            shell: Some("bash".to_string()),
            env: self.adapter_env(session_name),
            command: vec![
                shell_path.to_string(),
                "--rcfile".to_string(),
                rcfile.to_string_lossy().into_owned(),
                "-i".to_string(),
            ],
            supported: true,
            reason: None,
        })
    }

    async fn install_zsh_adapter(&self, session_name: &str) -> Result<ShellAdapter> {
        let dir = self.session_dir(session_name).join("shell").join("zsh");
        secure_dir(&dir).await?;
        for (name, content) in ZSH_ADAPTER_FILES {
            write_atomic(&dir.join(name), content).await?;
        }
        let mut env = self.adapter_env(session_name);
        // Only an explicitly configured ZDOTDIR has to be preserved. When the
        // Agent inherited none, the wrapper uses the Session's `$HOME` at
        // runtime — which is the home the shell itself will have, not the
        // Agent process's.
        if let Ok(original) = std::env::var("ZDOTDIR") {
            if !original.is_empty() {
                env.push((USER_ZDOTDIR_VAR.to_string(), original));
            }
        }
        env.push(("ZDOTDIR".to_string(), dir.to_string_lossy().into_owned()));
        Ok(ShellAdapter {
            shell: Some("zsh".to_string()),
            env,
            command: Vec::new(),
            supported: true,
            reason: None,
        })
    }

    fn adapter_env(&self, session_name: &str) -> Vec<(String, String)> {
        let dir = self.session_dir(session_name);
        vec![
            (
                ENV_RUNTIME_VAR.to_string(),
                dir.join(ENV_RUNTIME_FILE).to_string_lossy().into_owned(),
            ),
            (
                ENV_REVISION_VAR.to_string(),
                dir.join(ENV_REVISION_FILE).to_string_lossy().into_owned(),
            ),
            (
                SHELL_REVISION_VAR.to_string(),
                dir.join(SHELL_REVISION_FILE).to_string_lossy().into_owned(),
            ),
        ]
    }

    fn session_dir(&self, session_name: &str) -> PathBuf {
        self.state_dir.join(sanitize_component(session_name))
    }

    async fn load_state(&self, session_name: &str) -> Option<StoredBinding> {
        let path = self.session_dir(session_name).join(BINDING_STATE_FILE);
        let bytes = fs::read(&path).await.ok()?;
        match serde_json::from_slice::<StoredBinding>(&bytes) {
            Ok(state) => Some(state),
            Err(e) => {
                tracing::warn!("cannot parse env binding state {}: {e}", path.display());
                None
            }
        }
    }

    async fn save_state(&self, session_name: &str, state: &StoredBinding) -> Result<()> {
        let dir = self.session_dir(session_name);
        secure_dir(&dir).await?;
        let json = serde_json::to_vec_pretty(state).context("serialising env binding state")?;
        write_atomic(&dir.join(BINDING_STATE_FILE), json).await
    }

    async fn write_runtime_files(
        &self,
        dir: &Path,
        revision: u64,
        overlay: &EffectiveOverlay,
        restore: &[(String, Option<String>)],
    ) -> Result<()> {
        secure_dir(dir).await?;
        let mut script = String::new();
        script.push_str(&format!(
            "# Nession Session Environment Binding, revision {revision}.\n"
        ));
        script.push_str(
            "# This file is sourced by the Session-local shell adapter. It is not\n\
             # a general environment dump: only keys this binding manages appear.\n",
        );
        for (key, value) in &overlay.vars {
            script.push_str(&format!("export {key}={}\n", shell_quote(value)));
        }
        for (key, value) in restore {
            match value {
                Some(value) => {
                    script.push_str(&format!("export {key}={}\n", shell_quote(value)));
                }
                None => script.push_str(&format!("unset {key}\n")),
            }
        }
        write_atomic(&dir.join(ENV_RUNTIME_FILE), script).await?;
        write_atomic(&dir.join(ENV_REVISION_FILE), format!("{revision}\n")).await
    }

    fn status_for(
        &self,
        adapter: bool,
        revision: u64,
        shell_revision: Option<u64>,
        last_error: Option<&str>,
    ) -> String {
        if last_error.is_some() {
            return STATUS_ERROR.to_string();
        }
        if !adapter {
            // A Session with no recognized shell has Layer B but not Layer C.
            return STATUS_UNSUPPORTED_SHELL.to_string();
        }
        if shell_revision == Some(revision) {
            STATUS_IN_SYNC.to_string()
        } else {
            STATUS_PENDING_SHELL.to_string()
        }
    }
}

fn observed_from(state: &StoredBinding, shell_revision: Option<u64>) -> SessionEnvObservedState {
    SessionEnvObservedState {
        applied_revision: state.applied_revision,
        status: state.status.clone(),
        profiles: state
            .profiles
            .iter()
            .map(|profile| profile.profile.clone())
            .collect(),
        managed_keys: state.baseline.keys().cloned().collect(),
        shell: state.shell.clone(),
        shell_revision,
        // The reason an unsupported shell could not converge is useful to
        // reporting, but it is not a tmux failure. Expose it only when there
        // is no real error to show.
        last_error: state
            .last_error
            .clone()
            .or_else(|| state.adapter_reason.clone()),
    }
}

/// Why Nession refuses to let an Environment profile control `key`.
///
/// The policy is one place so the same key cannot be reserved on one path and
/// accepted on another. A profile that collides is warned about and skipped;
/// the base value wins.
fn reserved_key_reason(key: &str) -> Option<&'static str> {
    match key {
        "TMUX" => Some("tmux would stop addressing Nession's own server"),
        "TMUX_TMPDIR" => Some("tmux isolation is the explicit socket, never this variable"),
        "TERM" => Some("the Session's terminal policy is owned by Nession"),
        "LANG" => Some("locale policy is owned by Nession"),
        "ZDOTDIR" => Some("the zsh Session-local adapter owns this directory"),
        _ if key.starts_with("LC_") => Some("locale policy is owned by Nession"),
        _ if key.starts_with("NESSON_") => {
            Some("Nession runtime and integration variables are owned by Nession")
        }
        _ => None,
    }
}

/// Whether `key` is a portable shell variable name.
///
/// `export`/`unset` cannot express a name containing `=`, whitespace, or an
/// empty string; accepting one would make the binding claim a key every shell
/// silently mishandles. This is deliberately narrower than tmux's own
/// `show-environment` grammar, because the shell overlay is the layer that
/// consumes these names.
fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn shell_basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn shell_kind(path: &str) -> Option<String> {
    match shell_basename(path).as_str() {
        "bash" => Some("bash".to_string()),
        "zsh" => Some("zsh".to_string()),
        _ => None,
    }
}

fn sanitize_component(session_name: &str) -> String {
    session_name.replace(['/', '\\'], "_")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn write_atomic(path: &Path, contents: impl AsRef<[u8]>) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, contents)
        .await
        .with_context(|| format!("writing {}", tmp.display()))?;
    secure_file(&tmp).await?;
    fs::rename(&tmp, path)
        .await
        .with_context(|| format!("renaming {} to {}", tmp.display(), path.display()))?;
    Ok(())
}

async fn secure_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)
        .await
        .with_context(|| format!("creating {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .await
            .with_context(|| format!("securing {}", path.display()))?;
    }
    Ok(())
}

async fn secure_file(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .await
            .with_context(|| format!("securing {}", path.display()))?;
    }
    Ok(())
}

async fn read_revision(path: &Path) -> Option<u64> {
    let text = fs::read_to_string(path).await.ok()?;
    text.trim().parse().ok()
}

async fn read_state_session_name(path: &Path) -> Option<String> {
    let bytes = fs::read(path).await.ok()?;
    serde_json::from_slice::<StoredBinding>(&bytes)
        .ok()
        .map(|state| state.session_name)
}

/// The bash adapter.
///
/// tmux normally starts a login shell. `bash --rcfile` replaces the interactive
/// startup file, so this wrapper first sources the login profile chain bash
/// would have read, then installs the prompt hook after the user's own
/// configuration has run. It never writes to `~/.bashrc`.
const BASH_ADAPTER: &str = r#"# Nession Session-local bash adapter (#170 Phase B).
# This file is generated per Session. It sources the user's normal startup
# configuration; it never replaces or edits it.
if [ -r /etc/profile ]; then
  . /etc/profile
fi
if [ -r "$HOME/.bash_profile" ]; then
  . "$HOME/.bash_profile"
elif [ -r "$HOME/.bash_login" ]; then
  . "$HOME/.bash_login"
elif [ -r "$HOME/.profile" ]; then
  . "$HOME/.profile"
fi

__nession_env_sync() {
  [ -n "${NESSON_ENV_RUNTIME:-}" ] || return 0
  [ -r "${NESSON_ENV_RUNTIME}" ] || return 0
  local __nession_rev
  __nession_rev=$(cat "${NESSON_ENV_REVISION}" 2>/dev/null) || return 0
  [ "$__nession_rev" = "${NESSON_ENV_APPLIED_REVISION:-}" ] && return 0
  . "${NESSON_ENV_RUNTIME}"
  export NESSON_ENV_APPLIED_REVISION="$__nession_rev"
  if [ -n "${NESSON_ENV_SHELL_REVISION:-}" ]; then
    ( umask 077; printf '%s\n' "$__nession_rev" > "${NESSON_ENV_SHELL_REVISION}" ) 2>/dev/null
  fi
}

case "${PROMPT_COMMAND:-}" in
  *__nession_env_sync*) ;;
  "") PROMPT_COMMAND="__nession_env_sync" ;;
  *) PROMPT_COMMAND="__nession_env_sync;$PROMPT_COMMAND" ;;
esac
"#;

/// The zsh adapter files. `.zshenv` is read by every zsh invocation, so it only
/// forwards the user's own file; the hook belongs in `.zshrc`, after the user's
/// configuration has had its say.
const ZSH_ADAPTER_FILES: [(&str, &str); 5] = [
    (
        ".zshenv",
        r#"# Nession Session-local zsh adapter (#170 Phase B).
__nession_session_zdotdir="${ZDOTDIR:-$HOME}"
__nession_user_zdotdir="${NESSON_USER_ZDOTDIR:-$HOME}"
if [ -r "${__nession_user_zdotdir}/.zshenv" ]; then
  . "${__nession_user_zdotdir}/.zshenv"
fi
# A user .zshenv may change ZDOTDIR. Keep the Session-local startup chain ours;
# the user's own files are sourced explicitly by the wrappers below.
ZDOTDIR="$__nession_session_zdotdir"
export ZDOTDIR
"#,
    ),
    (
        ".zprofile",
        r#"__nession_user_zdotdir="${NESSON_USER_ZDOTDIR:-$HOME}"
if [ -r "${__nession_user_zdotdir}/.zprofile" ]; then
  . "${__nession_user_zdotdir}/.zprofile"
fi
"#,
    ),
    (
        ".zshrc",
        r#"# Nession Session-local zsh adapter (#170 Phase B).
__nession_user_zdotdir="${NESSON_USER_ZDOTDIR:-$HOME}"
if [ -r "${__nession_user_zdotdir}/.zshrc" ]; then
  . "${__nession_user_zdotdir}/.zshrc"
fi

__nession_env_sync() {
  [ -n "${NESSON_ENV_RUNTIME:-}" ] || return 0
  [ -r "${NESSON_ENV_RUNTIME}" ] || return 0
  local __nession_rev
  __nession_rev=$(cat "${NESSON_ENV_REVISION}" 2>/dev/null) || return 0
  [ "$__nession_rev" = "${NESSON_ENV_APPLIED_REVISION:-}" ] && return 0
  . "${NESSON_ENV_RUNTIME}"
  export NESSON_ENV_APPLIED_REVISION="$__nession_rev"
  if [ -n "${NESSON_ENV_SHELL_REVISION:-}" ]; then
    ( umask 077; printf '%s\n' "$__nession_rev" > "${NESSON_ENV_SHELL_REVISION}" ) 2>/dev/null
  fi
}

autoload -Uz add-zsh-hook
if [ -n "${precmd_functions[(r)__nession_env_sync]:-}" ]; then
  :
else
  add-zsh-hook precmd __nession_env_sync
fi
"#,
    ),
    (
        ".zlogin",
        r#"__nession_user_zdotdir="${NESSON_USER_ZDOTDIR:-$HOME}"
if [ -r "${__nession_user_zdotdir}/.zlogin" ]; then
  . "${__nession_user_zdotdir}/.zlogin"
fi
"#,
    ),
    (
        ".zlogout",
        r#"__nession_user_zdotdir="${NESSON_USER_ZDOTDIR:-$HOME}"
if [ -r "${__nession_user_zdotdir}/.zlogout" ]; then
  . "${__nession_user_zdotdir}/.zlogout"
fi
"#,
    ),
];

#[cfg(test)]
mod tests {
    use super::*;
    use nession_protocol::contracts::env::v1::EnvSource;

    fn snapshot(name: &str, vars: &[(&str, &str)]) -> EnvSnapshot {
        EnvSnapshot {
            name: name.to_string(),
            source: EnvSource::Server,
            agent_id: None,
            vars: vars
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn later_profile_wins_and_reserved_keys_are_refused() {
        let overlay = EnvManager::merge_snapshots(&[
            snapshot("base.env", &[("MODE", "base"), ("TERM", "dumb")]),
            snapshot("staging.env", &[("MODE", "staging"), ("TMUX", "/tmp/x")]),
        ])
        .expect("reserved keys are warnings, not errors");
        assert_eq!(
            overlay.vars,
            vec![("MODE".to_string(), "staging".to_string())]
        );
        assert_eq!(overlay.warnings.len(), 2);
        assert!(overlay.warnings.iter().any(|w| w.contains("TERM")));
        assert!(overlay.warnings.iter().any(|w| w.contains("TMUX")));
    }

    #[test]
    fn an_invalid_variable_name_is_an_error_not_a_warning() {
        let err = EnvManager::merge_snapshots(&[snapshot("bad.env", &[("BAD=NAME", "value")])])
            .expect_err("a name no shell can export must fail");
        let message = format!("{err:#}");
        assert!(message.contains("BAD=NAME"), "{message}");
        assert!(
            message.contains("invalid environment variable name"),
            "{message}"
        );
    }

    #[test]
    fn a_key_stays_in_its_first_position_when_a_later_profile_overrides_it() {
        // Order is the product's: [A, B] where both define X means X is in A's
        // position and B's value. Reordering the profiles changes the value
        // deterministically, not the key's position.
        let overlay = EnvManager::merge_snapshots(&[
            snapshot("a.env", &[("X", "1"), ("Y", "2")]),
            snapshot("b.env", &[("X", "3")]),
        ])
        .expect("valid names merge");
        assert_eq!(
            overlay.vars,
            vec![
                ("X".to_string(), "3".to_string()),
                ("Y".to_string(), "2".to_string())
            ]
        );
    }

    #[test]
    fn reordering_profiles_changes_the_effective_value() {
        let forward = EnvManager::merge_snapshots(&[
            snapshot("a.env", &[("MODE", "a")]),
            snapshot("b.env", &[("MODE", "b")]),
        ])
        .expect("valid names merge");
        let reverse = EnvManager::merge_snapshots(&[
            snapshot("b.env", &[("MODE", "b")]),
            snapshot("a.env", &[("MODE", "a")]),
        ])
        .expect("valid names merge");

        assert_eq!(
            forward.vars,
            vec![("MODE".to_string(), "b".to_string())],
            "the later profile must win"
        );
        assert_eq!(
            reverse.vars,
            vec![("MODE".to_string(), "a".to_string())],
            "the same profiles in the opposite order must produce the other value"
        );
        assert_ne!(
            forward.vars, reverse.vars,
            "reordering the selection must change the materialized value"
        );
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn session_components_do_not_escape_the_state_dir() {
        assert_eq!(sanitize_component("a/b\\c"), "a_b_c");
        assert!(!sanitize_component("../x").contains('/'));
    }

    #[test]
    fn zsh_adapter_keeps_the_users_files_in_the_chain() {
        let files = ZSH_ADAPTER_FILES
            .iter()
            .map(|(name, _)| *name)
            .collect::<Vec<_>>();
        assert_eq!(
            files,
            vec![".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"]
        );
        let zshrc = ZSH_ADAPTER_FILES
            .iter()
            .find(|(name, _)| *name == ".zshrc")
            .expect("the hook belongs in .zshrc")
            .1;
        assert!(zshrc.contains("NESSON_USER_ZDOTDIR"));
        assert!(zshrc.contains("add-zsh-hook precmd"));
        assert!(zshrc.contains("NESSON_ENV_RUNTIME"));
        assert!(!zshrc.contains("tmux show-environment"));
    }

    #[test]
    fn bash_adapter_never_mentions_global_rc_files_or_send_keys() {
        assert!(!BASH_ADAPTER.contains(".bashrc"));
        assert!(!BASH_ADAPTER.contains("send-keys"));
        assert!(!BASH_ADAPTER.contains("show-environment"));
        assert!(BASH_ADAPTER.contains("PROMPT_COMMAND"));
        assert!(BASH_ADAPTER.contains("NESSON_ENV_RUNTIME"));
    }

    #[test]
    fn unsupported_shell_degrades_explicitly() {
        let adapter = ShellAdapter::unsupported(Some("fish".to_string()), "no adapter");
        assert!(!adapter.supported);
        assert_eq!(adapter.shell.as_deref(), Some("fish"));
        assert!(adapter.reason.is_some());
    }

    #[test]
    fn reserved_policy_covers_runtime_keys_but_allows_path() {
        for key in [
            "TMUX",
            "TMUX_TMPDIR",
            "TERM",
            "LANG",
            "LC_ALL",
            "ZDOTDIR",
            "NESSON_PS1",
        ] {
            assert!(reserved_key_reason(key).is_some(), "{key} must be reserved");
        }
        assert!(reserved_key_reason("PATH").is_none());
        assert!(reserved_key_reason("ANTHROPIC_API_KEY").is_none());
    }

    // ── the binding engine, against a fake tmux ──────────────────────────────

    /// A fake that answers `show-environment` for `BASE_KEPT` and reports the
    /// rest as unset, and accepts every mutation.
    #[cfg(unix)]
    fn fake_with_a_base_value(dir: &std::path::Path) -> crate::test_support::FakeTmux {
        crate::test_support::FakeTmux::new(
            dir,
            "case \"$1\" in \
             show-environment) case \"$4\" in \
               BASE_KEPT) printf 'BASE_KEPT=base\\n'; exit 0;; \
               *) echo \"unknown variable: $4\" >&2; exit 1;; \
             esac;; \
             *) exit 0;; esac",
        )
    }

    fn profile_ref(name: &str) -> SessionEnvProfile {
        SessionEnvProfile {
            profile: EnvFileRef {
                name: name.to_string(),
                source: EnvSource::Server,
                agent_id: None,
            },
            phase: "attach".to_string(),
            content_hash: None,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn replacing_a_binding_restores_the_captured_base_value_and_unsets_absent_keys() {
        let dir = tempfile::tempdir().unwrap();
        let fake = fake_with_a_base_value(dir.path());
        let mut mgr = EnvManager::new(dir.path().join("state"));
        mgr.with_tmux(fake.dep());

        let first = mgr
            .apply_binding(
                "nession-binding-sess",
                1,
                &[profile_ref("a.env")],
                &[snapshot(
                    "a.env",
                    &[("BASE_KEPT", "profile"), ("ABSENT", "x")],
                )],
            )
            .await
            .expect("the fake accepts the overlay");
        assert!(first.warnings.is_empty());
        assert_eq!(
            first.observed.managed_keys,
            vec!["ABSENT".to_string(), "BASE_KEPT".to_string()],
            "the baseline is the record of what the binding manages"
        );
        let overlay_path = mgr
            .session_dir("nession-binding-sess")
            .join(ENV_RUNTIME_FILE);
        let first_overlay = tokio::fs::read_to_string(&overlay_path).await.unwrap();
        assert!(first_overlay.contains("export BASE_KEPT='profile'"));
        assert!(first_overlay.contains("export ABSENT='x'"));

        let second = mgr
            .apply_binding("nession-binding-sess", 2, &[], &[])
            .await
            .expect("clearing the binding restores the base");
        assert!(second.observed.managed_keys.is_empty());

        let calls = fake.calls();
        assert!(
            calls.iter().any(|call| call
                == &vec![
                    "set-environment".to_string(),
                    "-t".to_string(),
                    "nession-binding-sess".to_string(),
                    "BASE_KEPT".to_string(),
                    "base".to_string()
                ]),
            "the base value must be restored, not unset: {calls:#?}"
        );
        assert!(
            calls.iter().any(|call| call
                == &vec![
                    "set-environment".to_string(),
                    "-u".to_string(),
                    "-t".to_string(),
                    "nession-binding-sess".to_string(),
                    "ABSENT".to_string()
                ]),
            "a key with no base value must be unset: {calls:#?}"
        );
        let second_overlay = tokio::fs::read_to_string(&overlay_path).await.unwrap();
        assert!(second_overlay.contains("export BASE_KEPT='base'"));
        assert!(second_overlay.contains("unset ABSENT"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_reserved_key_is_warned_about_and_never_sent_to_tmux() {
        let dir = tempfile::tempdir().unwrap();
        let fake = crate::test_support::FakeTmux::new(dir.path(), "exit 0");
        let mut mgr = EnvManager::new(dir.path().join("state"));
        mgr.with_tmux(fake.dep());

        let outcome = mgr
            .apply_binding(
                "nession-reserved-sess",
                1,
                &[profile_ref("a.env")],
                &[snapshot(
                    "a.env",
                    &[("TMUX", "/tmp/other"), ("TERM", "dumb")],
                )],
            )
            .await
            .expect("reserved keys are skipped, not fatal");
        assert_eq!(outcome.warnings.len(), 2);
        assert!(outcome.observed.managed_keys.is_empty());
        assert!(
            fake.calls()
                .iter()
                .all(|call| call.first().map(String::as_str) != Some("set-environment")),
            "a reserved key must never reach the tmux environment: {:#?}",
            fake.calls()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_required_tmux_refusal_is_returned_as_an_error_and_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            "case \"$1\" in \
             show-environment) echo \"unknown variable: $4\" >&2; exit 1;; \
             set-environment) echo 'refused by fake' >&2; exit 1;; \
             *) exit 0;; esac",
        );
        let mut mgr = EnvManager::new(dir.path().join("state"));
        mgr.with_tmux(fake.dep());

        let err = mgr
            .apply_binding(
                "nession-refused-sess",
                1,
                &[profile_ref("a.env")],
                &[snapshot("a.env", &[("REFUSED", "v")])],
            )
            .await
            .expect_err("a refused required mutation is not success");
        assert!(format!("{err:#}").contains("refused by fake"));

        let observed = mgr
            .observe("nession-refused-sess")
            .await
            .expect("the failed apply is recorded");
        assert_eq!(observed.status, STATUS_ERROR);
        assert!(observed
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("refused by fake")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn materializing_a_binding_never_injects_terminal_input() {
        let dir = tempfile::tempdir().unwrap();
        let fake = fake_with_a_base_value(dir.path());
        let mut mgr = EnvManager::new(dir.path().join("state"));
        mgr.with_tmux(fake.dep());

        mgr.apply_binding(
            "nession-no-input-sess",
            1,
            &[profile_ref("a.env")],
            &[snapshot("a.env", &[("X", "1")])],
        )
        .await
        .expect("the fake accepts the overlay");

        // A foreground TUI must receive no input when the binding changes.
        // The mutation path may inspect tmux's environment and mutate it; it
        // must never type into the pane.
        let calls = fake.calls();
        let commands: Vec<&str> = calls
            .iter()
            .filter_map(|call| call.first().map(String::as_str))
            .collect();
        assert!(
            commands
                .iter()
                .all(|command| matches!(*command, "show-environment" | "set-environment")),
            "a binding change wrote to the terminal instead of the environment: {calls:#?}"
        );
        assert!(
            !commands.iter().any(|command| matches!(
                *command,
                "send-keys" | "paste-buffer" | "load-buffer" | "set-buffer"
            )),
            "a binding change injected terminal input: {calls:#?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_unsupported_shell_reports_its_status_and_still_materializes_tmux() {
        let dir = tempfile::tempdir().unwrap();
        let fake = fake_with_a_base_value(dir.path());
        let mut mgr = EnvManager::new(dir.path().join("state"));
        mgr.with_tmux(fake.dep());

        let adapter = mgr
            .install_shell_adapter("nession-fish-sess", Some("/usr/local/bin/fish"))
            .await;
        assert!(!adapter.supported, "fish has no proven adapter");
        assert_eq!(adapter.shell.as_deref(), Some("fish"));

        let overlay = EnvManager::merge_snapshots(&[snapshot("a.env", &[("X", "1")])]).unwrap();
        mgr.record_created_binding(
            "nession-fish-sess",
            1,
            &[profile_ref("a.env")],
            &overlay,
            BTreeMap::new(),
            &adapter,
        )
        .await
        .expect("the created binding is recorded");

        let observed = mgr
            .observe("nession-fish-sess")
            .await
            .expect("the binding is recorded");
        assert_eq!(observed.status, STATUS_UNSUPPORTED_SHELL);

        let outcome = mgr
            .apply_binding(
                "nession-fish-sess",
                2,
                &[profile_ref("a.env")],
                &[snapshot("a.env", &[("X", "2")])],
            )
            .await
            .expect("the tmux layer still converges");
        assert_eq!(
            outcome.observed.status, STATUS_UNSUPPORTED_SHELL,
            "an unsupported shell must report its real status, not success"
        );
        assert!(
            fake.calls().iter().any(|call| call
                == &vec![
                    "set-environment".to_string(),
                    "-t".to_string(),
                    "nession-fish-sess".to_string(),
                    "X".to_string(),
                    "2".to_string()
                ]),
            "an unsupported shell still has to materialize the tmux layer: {:#?}",
            fake.calls()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_recorded_binding_survives_an_agent_restart() {
        let dir = tempfile::tempdir().unwrap();
        let fake = fake_with_a_base_value(dir.path());
        let state_dir = dir.path().join("state");

        let mut first = EnvManager::new(state_dir.clone());
        first.with_tmux(fake.dep());
        first
            .apply_binding(
                "nession-restart-sess",
                3,
                &[profile_ref("a.env")],
                &[snapshot("a.env", &[("X", "1")])],
            )
            .await
            .expect("the binding applies");
        drop(first);

        // A new process has only the durable state directory, not the old
        // manager's memory.
        let mut restarted = EnvManager::new(state_dir);
        restarted.with_tmux(fake.dep());
        let observed = restarted
            .observe("nession-restart-sess")
            .await
            .expect("the binding survives an Agent restart");
        assert_eq!(observed.applied_revision, 3);
        assert_eq!(observed.managed_keys, vec!["X".to_string()]);

        let live = restarted.live_binding_states().await;
        assert!(
            live.iter()
                .any(|(name, state)| name == "nession-restart-sess" && state.applied_revision == 3),
            "the restart report must include the recovered binding: {live:#?}"
        );
    }

    // ── the shell adapter, against a real shell ──────────────────────────────

    /// Spawn the generated adapter in a real interactive shell and return the
    /// child, its stdin, and a line reader over stdout.
    #[cfg(unix)]
    async fn spawn_adapter_shell(
        shell_path: &str,
        adapter: &ShellAdapter,
        home: &Path,
    ) -> (
        tokio::process::Child,
        tokio::process::ChildStdin,
        tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    ) {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, BufReader};

        // not-tmux: this test launches the user's shell to exercise the
        // Session adapter; it never invokes tmux.
        let mut command = tokio::process::Command::new(shell_path);
        if adapter.command.is_empty() {
            command.arg("-i");
        } else {
            command.args(&adapter.command[1..]);
        }
        command
            .env_clear()
            .env("HOME", home)
            .env(
                "PATH",
                std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string()),
            )
            .env("SHELL", shell_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (key, value) in &adapter.env {
            command.env(key, value);
        }
        let mut child = command.spawn().expect("the shell starts");
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        (child, stdin, BufReader::new(stdout).lines())
    }

    #[cfg(unix)]
    async fn write_and_wait(
        stdin: &mut tokio::process::ChildStdin,
        lines: &mut tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
        command: &str,
        marker: &str,
    ) -> String {
        use tokio::io::AsyncWriteExt;
        stdin
            .write_all(format!("{command}\n").as_bytes())
            .await
            .expect("writing to the shell");
        loop {
            let line = tokio::time::timeout(std::time::Duration::from_secs(10), lines.next_line())
                .await
                .expect("the shell answers a prompt")
                .expect("the shell stdout is readable")
                .expect("the shell is still running");
            if line.contains(marker) {
                return line;
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_bash_adapter_converges_at_the_next_prompt_and_preserves_user_config() {
        let shell = "/bin/bash";
        assert!(
            std::path::Path::new(shell).exists(),
            "bash is required for this test"
        );
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".bash_profile"), "export NESSION_USER_VAR=kept\n").unwrap();

        let mgr = EnvManager::new(dir.path().join("state"));
        let adapter = mgr
            .install_shell_adapter("nession-shell-sess", Some(shell))
            .await;
        assert!(adapter.supported, "{:?}", adapter.reason);
        let session_dir = mgr.session_dir("nession-shell-sess");
        mgr.write_runtime_files(
            &session_dir,
            1,
            &EffectiveOverlay {
                vars: vec![("NESSION_TEST".to_string(), "one".to_string())],
                warnings: Vec::new(),
            },
            &[],
        )
        .await
        .unwrap();

        let (mut child, mut stdin, mut lines) = spawn_adapter_shell(shell, &adapter, &home).await;
        let line = write_and_wait(
            &mut stdin,
            &mut lines,
            "echo \"USER:$NESSION_USER_VAR VAL1:$NESSION_TEST\"",
            "USER:",
        )
        .await;
        assert!(line.contains("USER:kept"), "user config was lost: {line}");
        assert!(
            line.contains("VAL1:one"),
            "the first overlay did not apply: {line}"
        );

        // The Agent materializes a new revision while the shell is idle at its
        // prompt. Nothing is typed into the terminal; the next prompt boundary
        // is what converges.
        mgr.write_runtime_files(
            &session_dir,
            2,
            &EffectiveOverlay {
                vars: vec![("NESSION_TEST".to_string(), "two".to_string())],
                warnings: Vec::new(),
            },
            &[],
        )
        .await
        .unwrap();
        let line = write_and_wait(
            &mut stdin,
            &mut lines,
            "echo \"VAL2:$NESSION_TEST\"",
            "VAL2:",
        )
        .await;
        assert!(
            line.contains("VAL2:two"),
            "the new revision did not converge: {line}"
        );

        let marker = tokio::fs::read_to_string(session_dir.join(SHELL_REVISION_FILE))
            .await
            .unwrap();
        assert_eq!(
            marker.trim(),
            "2",
            "the shell reported the revision it applied"
        );

        drop(stdin);
        let _ = child.wait().await;
    }

    /// A child started before the binding changes keeps the environment it was
    /// born with. The shell converges at its next prompt; processes already
    /// running are not rewritten.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_running_child_keeps_its_environment_when_the_binding_changes() {
        let shell = "/bin/bash";
        assert!(
            std::path::Path::new(shell).exists(),
            "bash is required for this test"
        );
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();

        let mgr = EnvManager::new(dir.path().join("state"));
        let adapter = mgr
            .install_shell_adapter("nession-child-sess", Some(shell))
            .await;
        assert!(adapter.supported, "{:?}", adapter.reason);
        let session_dir = mgr.session_dir("nession-child-sess");
        mgr.write_runtime_files(
            &session_dir,
            1,
            &EffectiveOverlay {
                vars: vec![("NESSION_TEST".to_string(), "one".to_string())],
                warnings: Vec::new(),
            },
            &[],
        )
        .await
        .unwrap();

        let (mut child, mut stdin, mut lines) = spawn_adapter_shell(shell, &adapter, &home).await;

        // The child inherits `one` at fork. It reports the value it was born
        // with after the binding has been replaced in the shell.
        let line = write_and_wait(
            &mut stdin,
            &mut lines,
            "(sleep 2; echo \"CHILD:$NESSION_TEST\") & echo \"CHILD-STARTED\"",
            "CHILD-STARTED",
        )
        .await;
        assert!(line.contains("CHILD-STARTED"), "{line}");

        mgr.write_runtime_files(
            &session_dir,
            2,
            &EffectiveOverlay {
                vars: vec![("NESSION_TEST".to_string(), "two".to_string())],
                warnings: Vec::new(),
            },
            &[],
        )
        .await
        .unwrap();
        let line = write_and_wait(
            &mut stdin,
            &mut lines,
            "echo \"VAL2:$NESSION_TEST\"",
            "VAL2:",
        )
        .await;
        assert!(
            line.contains("VAL2:two"),
            "the interactive shell did not converge: {line}"
        );

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "the running child never reported its inherited environment"
            );
            let line = tokio::time::timeout(remaining, lines.next_line())
                .await
                .expect("the child reports within the deadline")
                .expect("the shell stdout is readable")
                .expect("the shell is still running");
            if let Some(value) = line.split("CHILD:").nth(1) {
                assert!(
                    value.contains("one"),
                    "a running child's environment was rewritten: {line}"
                );
                break;
            }
        }

        drop(stdin);
        let _ = child.wait().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_zsh_adapter_converges_at_the_next_prompt_and_preserves_user_config() {
        // The zsh adapter is exercised where zsh exists. The Linux Rust runner
        // does not ship it; the macOS developer host does, and the same test is
        // part of the normal suite there. The skip is stated rather than silent
        // so a green Linux run is not read as zsh proof.
        let shell = ["/bin/zsh", "/usr/bin/zsh"]
            .into_iter()
            .find(|path| std::path::Path::new(path).exists());
        let Some(shell) = shell else {
            eprintln!("zsh not available on this host; skipping the zsh adapter test");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".zshrc"), "export NESSION_USER_VAR=kept\n").unwrap();

        let mgr = EnvManager::new(dir.path().join("state"));
        let adapter = mgr
            .install_shell_adapter("nession-zsh-sess", Some(shell))
            .await;
        assert!(adapter.supported, "{:?}", adapter.reason);
        let session_dir = mgr.session_dir("nession-zsh-sess");
        mgr.write_runtime_files(
            &session_dir,
            1,
            &EffectiveOverlay {
                vars: vec![("NESSION_TEST".to_string(), "one".to_string())],
                warnings: Vec::new(),
            },
            &[],
        )
        .await
        .unwrap();

        let (mut child, mut stdin, mut lines) = spawn_adapter_shell(shell, &adapter, &home).await;
        let line = write_and_wait(
            &mut stdin,
            &mut lines,
            "echo \"USER:$NESSION_USER_VAR VAL1:$NESSION_TEST\"",
            "USER:",
        )
        .await;
        assert!(line.contains("USER:kept"), "user config was lost: {line}");
        assert!(
            line.contains("VAL1:one"),
            "the first overlay did not apply: {line}"
        );

        mgr.write_runtime_files(
            &session_dir,
            2,
            &EffectiveOverlay {
                vars: vec![("NESSION_TEST".to_string(), "two".to_string())],
                warnings: Vec::new(),
            },
            &[],
        )
        .await
        .unwrap();
        let line = write_and_wait(
            &mut stdin,
            &mut lines,
            "echo \"VAL2:$NESSION_TEST\"",
            "VAL2:",
        )
        .await;
        assert!(
            line.contains("VAL2:two"),
            "the new revision did not converge: {line}"
        );

        let marker = tokio::fs::read_to_string(session_dir.join(SHELL_REVISION_FILE))
            .await
            .unwrap();
        assert_eq!(
            marker.trim(),
            "2",
            "the shell reported the revision it applied"
        );

        drop(stdin);
        let _ = child.wait().await;
    }
}
