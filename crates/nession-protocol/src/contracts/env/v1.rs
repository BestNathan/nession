use serde::{Deserialize, Serialize};

// ============================================================================
// Environment-variable file management
// ============================================================================

/// Where an env file physically lives.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvSource {
    /// Stored on the central server (`~/.nession/server/envs`). Uploaded or
    /// created via the Web UI; authoritative and syncable to agents.
    Server,
    /// Discovered locally on an agent node (`~/.nession/agent/envs`).
    Agent,
}

impl EnvSource {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            EnvSource::Server => "server",
            EnvSource::Agent => "agent",
        }
    }
}

/// Metadata describing a single env file in a listing.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvFileInfo {
    /// Filename including the `.env` suffix (e.g. `staging.env`).
    pub name: String,
    /// Where the file lives.
    pub source: EnvSource,
    /// For `EnvSource::Agent`, the owning agent id. `None` for server files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// File size in bytes.
    pub size: u64,
    /// Last-modified time (unix seconds).
    pub modified: u64,
    /// Number of resolved variables (best-effort; excludes malformed lines).
    pub var_count: usize,
}

/// A reference to an env file, used to select files for a session.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvFileRef {
    pub name: String,
    pub source: EnvSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

/// A resolved env-file snapshot: the file's parsed variables captured at
/// use-time so later edits don't affect a running session.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvSnapshot {
    pub name: String,
    pub source: EnvSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Ordered KEY/VALUE pairs (already deduplicated, last-wins).
    pub vars: Vec<(String, String)>,
    /// Non-fatal parse warnings surfaced to the UI.
    #[serde(default)]
    pub warnings: Vec<String>,
}

// --- Client → Server env CRUD payloads ---

/// `server.env.list` — list env files from server + all online agents.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClientEnvListPayload {}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvListResponsePayload {
    pub files: Vec<EnvFileInfo>,
    /// Set only when the Server refuses before listing anything — an
    /// unauthenticated caller is told why rather than handed a silently empty
    /// list.
    ///
    /// The Server has always put this on the wire and the Web has always read
    /// it (`EnvListResponse.error` in `capabilities/env/types.ts`); the type
    /// simply did not describe it. Adding it here makes the contract say what
    /// the wire already carries, which is why it changes no behaviour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The Server's `parse_env_ref` reads any `source` other than `"agent"` as a
/// server file — including an absent one, which two tests pin.
///
/// The contract says the same rather than being stricter than the code it
/// describes: a payload the Server accepts today must not start being refused
/// because a type was attached to it. Relaxing a requirement is allowed only
/// where the handler already tolerates the absence, and here it does.
fn default_env_source() -> EnvSource {
    EnvSource::Server
}

/// `server.env.get` — read one env file's raw content for editing.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvGetPayload {
    pub name: String,
    #[serde(default = "default_env_source")]
    pub source: EnvSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvGetResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Session ids currently using this file; an empty list when nothing is.
    ///
    /// Optional because two of the Server's branches answer before it is ever
    /// computed — an unauthenticated caller, and a request naming no file. An
    /// empty list there would not be a missing value but a false one: "nothing
    /// is using this file" when the truth is "we never looked".
    ///
    /// Both branches already omit it on the wire, so this states what the wire
    /// does rather than changing it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_use_by: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `server.env.write` — create or overwrite an env file (server or agent).
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvWritePayload {
    pub name: String,
    #[serde(default = "default_env_source")]
    pub source: EnvSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// The file's contents.
    ///
    /// Defaulted because the Server has always read a missing `content` as the
    /// empty string, and a request it accepted yesterday must not start being
    /// refused because a type was attached to it. That tolerance is worth
    /// questioning on its own — a write that quietly creates an empty file is a
    /// footgun — but questioning it is a behaviour change, not a contract one.
    #[serde(default)]
    pub content: String,
    /// When false, refuse to overwrite an existing file (create-only).
    #[serde(default)]
    pub overwrite: bool,
    /// Overwrite even though a running session has the file sourced, then
    /// re-source it.
    ///
    /// Read off `Value` beside the parser until now, like `delete`'s `force`
    /// and for the same reason: the field has always been on the wire and was
    /// never named here.
    #[serde(default)]
    pub force: bool,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvWriteResponsePayload {
    pub success: bool,
    /// True when the write was refused because the file already exists and
    /// `overwrite` was false (UI prompts for confirmation).
    #[serde(default)]
    pub exists: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Sessions holding the file, on the refusal that names them.
    ///
    /// Optional for the same reason as `ClientEnvGetResponsePayload::in_use_by`
    /// — it is computed on exactly one branch — and for a blunter one: this
    /// field was on the wire without being in the contract at all, so any
    /// consumer reading the schema had no way to know it existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_use_by: Option<Vec<String>>,
    /// Sessions re-sourced after a forced write. Reported on the success branch
    /// only, because it is the only branch that re-sources anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub re_sourced: Option<Vec<String>>,
    /// Why any of those re-sources failed. Same branch as `re_sourced`, and
    /// absent for the same reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub re_source_errors: Option<Vec<String>>,
}

/// `server.env.delete` — delete an env file.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvDeletePayload {
    pub name: String,
    #[serde(default = "default_env_source")]
    pub source: EnvSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Delete even though a running session has the file sourced.
    ///
    /// The Web has always sent this (`deleteEnvFile`'s `force`, documented as
    /// overriding in-use protection) and the Server has always read it off the
    /// payload — the contract simply did not name it, so a consumer reading the
    /// schema could not know the field existed. `ClientEnvWritePayload` already
    /// carries its own counterpart (`overwrite`); this was the missing half.
    #[serde(default)]
    pub force: bool,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvDeleteResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ============================================================================
// Session Environment Binding (#170 Phase A)
// ============================================================================

/// One profile selected by a Session's Environment Binding.
///
/// The profile identity is [`EnvFileRef`]; the extra fields are provenance and
/// materialization state, not a second identity. `phase` keeps the historical
/// "create" / "attach" distinction for the visibility projection: a profile
/// selected while the Session was created keeps `create` for the Session's
/// lifetime, and one added later is `attach`. The binding itself is ordered and
/// replace-whole; nothing here makes a client the owner of the binding.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionEnvProfile {
    pub profile: EnvFileRef,
    /// `"create"` or `"attach"` (provenance only).
    #[serde(default)]
    pub phase: String,
    /// SHA-256 of the profile content captured when this revision was
    /// materialized. Absent on the Agent-facing wire: the Agent records the
    /// content it applied, not a Server-side identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

/// One desired profile plus what the Server currently knows about its
/// materialization.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEnvBindingProfileState {
    pub profile: EnvFileRef,
    pub phase: String,
    /// Hash captured at the binding revision the Session is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    /// The file's current content no longer hashes to `content_hash`. This is
    /// the "profile changed since Session materialization" signal; it does not
    /// mutate the running Session.
    #[serde(default)]
    pub outdated: bool,
}

/// What the Agent has actually materialized for one Session.
///
/// Values are deliberately **not** on this wire: the Server and the UI need to
/// know which keys are managed and how far convergence got, not what their
/// secrets are.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionEnvObservedState {
    /// The binding revision the Agent last applied.
    pub applied_revision: u64,
    /// `in_sync`, `applying`, `pending_shell`, `unsupported_shell`, or `error`.
    pub status: String,
    /// The profiles materialized at `applied_revision`, in order.
    #[serde(default)]
    pub profiles: Vec<EnvFileRef>,
    /// Keys the binding currently manages. Names only.
    #[serde(default)]
    pub managed_keys: Vec<String>,
    /// The shell the Session adapter was installed for, when one was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    /// The revision the interactive shell last reported converging to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// The full Session Environment Binding state: desired intent plus observed
/// materialization.
///
/// A Session always has a binding state, even when it is empty: `desired` is
/// then empty with revision 0, and `observed` says what the Agent has (or
/// `None` when the Agent cannot be asked).
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEnvBindingState {
    pub session_id: String,
    pub desired_revision: u64,
    #[serde(default)]
    pub desired_profiles: Vec<SessionEnvBindingProfileState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed: Option<SessionEnvObservedState>,
    /// Why `observed` is absent or the binding could not be read. Desired
    /// state is still returned when only the Agent query failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// An active env application on a session (for visibility). Reported alongside
/// session listings / attach info.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveEnvFile {
    pub name: String,
    pub source: EnvSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// "create" (injected at session creation) or "attach" (applied on attach).
    pub phase: String,
    /// The client/user that applied it (best-effort identifier).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_by: Option<String>,
}

// --- Server → Agent env command payloads ---

/// `server.env.list` — ask an agent for its local env files.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerEnvListPayload {
    pub request_id: String,
}

/// `server.env.get` — read one agent-local env file.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerEnvGetPayload {
    pub request_id: String,
    pub name: String,
}

/// `server.env.write` — write an agent-local env file.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerEnvWritePayload {
    pub request_id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub overwrite: bool,
}

/// `server.env.delete` — delete an agent-local env file.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerEnvDeletePayload {
    pub request_id: String,
    pub name: String,
}

// --- Session Environment Binding, Server → Agent ---

/// `agent.session.env.binding.set` — replace the whole binding of one
/// Session.
///
/// The Server has already resolved the ordered profile snapshots; the Agent
/// materializes them. `revision` is the Server's desired revision and is echoed
/// back in the observed state, which is how the two sides tell "applied" from
/// "desired but not applied".
///
/// `profiles` and `snapshots` are the same ordered selection: entry `i` of one
/// describes entry `i` of the other. They are separate because the profile ref
/// is the durable identity and the snapshot is the content captured for this
/// revision.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionEnvBindingSetPayload {
    pub request_id: String,
    /// Bare tmux session name, as the Agent knows it.
    pub name: String,
    pub revision: u64,
    #[serde(default)]
    pub profiles: Vec<SessionEnvProfile>,
    #[serde(default)]
    pub snapshots: Vec<EnvSnapshot>,
}

/// `agent.session.env.binding.get` — read one Session's observed binding state.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionEnvBindingGetPayload {
    pub request_id: String,
    pub name: String,
}

/// The `observed` half of the Agent's answer to
/// `agent.session.env.binding.get`, carried on `server.agent.command-response`.
///
/// A Session with no recorded binding has `observed: None` rather than a
/// synthetic empty state: an old Session's absence of a binding is not the same
/// claim as a Session intentionally bound to `[]`.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSessionEnvBindingGetResponsePayload {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed: Option<SessionEnvObservedState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One Session's observed state, as an Agent reports it after a reconnect.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSessionEnvBindingReportEntry {
    pub session_name: String,
    pub observed: SessionEnvObservedState,
}

/// `server.agent.session-env-binding` — an Agent reports the observed binding
/// state of its live Sessions.
///
/// One-way, like `server.agent.session-update`: the Server updates its observed
/// cache and answers nothing. Sent after registration, so a Server restart (or
/// an Agent reconnect) does not make a live Session look unbound merely because
/// the Server's cache was empty.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSessionEnvBindingReportPayload {
    pub agent_id: String,
    #[serde(default)]
    pub sessions: Vec<AgentSessionEnvBindingReportEntry>,
}
