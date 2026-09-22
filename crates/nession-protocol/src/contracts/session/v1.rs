use serde::{Deserialize, Serialize};

use crate::contracts::agent::v1::ProbedAddress;
use crate::contracts::env::v1::{ActiveEnvFile, EnvFileRef, EnvSnapshot};

// --- Server → Agent command payloads ---

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionCreatePayload {
    pub request_id: String,
    pub name: String,
    #[serde(default = "default_width")]
    pub width: u16,
    #[serde(default = "default_height")]
    pub height: u16,
    /// Resolved env-file snapshots to inject via `tmux new-session -e`.
    /// Empty (default) preserves the pre-env-feature behaviour exactly.
    #[serde(default)]
    pub env_snapshots: Vec<EnvSnapshot>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionKillPayload {
    pub request_id: String,
    pub name: String,
}

pub(crate) fn default_width() -> u16 {
    80
}

pub(crate) fn default_height() -> u16 {
    24
}

// --- Agent → Server command response payload ---

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCommandResponsePayload {
    pub request_id: String,
    pub command: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
}

// --- Client → Server session command payloads ---

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionCreatePayload {
    pub agent_id: String,
    pub name: String,
    /// Env files to source into the session as it is created.
    ///
    /// The Server has always read this off the payload and the Web has always
    /// sent it. It was not declared, and moving the payload into the type is
    /// what surfaced that — a move is not something a `json!`-style read can
    /// hide, so the compiler pointed at the second read instead of a reviewer
    /// having to notice it.
    #[serde(default)]
    pub env_files: Vec<EnvFileRef>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionKillPayload {
    pub session_id: String,
}

// --- Server → Client session command response payloads ---

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionCreateResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionKillResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// --- Client ↔ Server session attach ---

/// `server.session.attach` — request to attach to a session.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionAttachPayload {
    pub session_id: String,
    /// "auto" | "p2p" | "relay". The client resolves "auto" itself by first
    /// asking for "p2p" and falling back to "relay", so the server only ever
    /// sees "p2p" or "relay" in practice.
    #[serde(default = "default_attach_mode")]
    pub preferred_mode: String,
    /// Resolved env-file snapshots for attach-time injection (relay mode).
    /// Empty (default) preserves the pre-env-feature behaviour.
    #[serde(default)]
    pub env_snapshots: Vec<EnvSnapshot>,
    /// When set, the server connects to this exact URL for relay mode instead
    /// of auto-selecting from the agent's advertised addresses.  The URL must
    /// be one of the addresses returned in the attach response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
}

pub(crate) fn default_attach_mode() -> String {
    "p2p".to_string()
}

/// Server → Client response to `server.session.attach`.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionAttachResponsePayload {
    /// "success" or "error".
    pub status: String,
    /// "p2p" or "relay".
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    /// Legacy single endpoint (first/preferred address). Kept so old clients
    /// that only read `agent_address` keep working.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_address: Option<String>,
    /// Full list of candidate endpoints with probe status, priority order.
    /// Clients test latency across these and fall back address-by-address.
    #[serde(default)]
    pub addresses: Vec<ProbedAddress>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// --- Env application to sessions ---

/// `server.session.env.apply` — apply env files to an already-running session
/// via `tmux set-environment` (attach-time).
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionEnvApplyPayload {
    pub session_id: String,
    pub env_files: Vec<EnvFileRef>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionEnvUnsetPayload {
    pub session_id: String,
    /// The specific files (by name) previously applied by this client that
    /// should now be removed via `tmux set-environment -u`.
    pub env_files: Vec<EnvFileRef>,
}

/// `agent.session.list`'s request: empty, and explicitly so.
///
/// The arm reads nothing off the payload — the Server asks and the agent
/// answers from its own tmux. `request: None` would say "this unit has no
/// request", which is false; it has one and it is empty. #920's edge cases call
/// this out directly: represent an empty request, do not conflate "empty" with
/// "no shape".
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentSessionListPayload {}

/// `server.session.env.active` — request and reply.
///
/// The reply is **one shape with an optional error**, not two disjoint halves:
/// the refusal branches carry an empty list as well. So this needs no union,
/// unlike `ServerSessionListReply`.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionEnvActivePayload {
    pub session_id: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEnvActiveResponse {
    pub active: Vec<ActiveEnvFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `server.session.env.query` — request and reply.
///
/// Same shape as [`SessionEnvActiveResponse`]: one object with an optional
/// error, not two disjoint halves.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionEnvQueryPayload {
    pub session_id: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEnvQueryResponse {
    /// **Names**, not references — the handler maps the agent's array through
    /// `as_str`, so this wire carries `["staging.env", …]` and not
    /// `[{ name, source, agent_id }]`. Written as `Vec<EnvFileRef>` first,
    /// which is what the field looks like it should be; reading the branch is
    /// what said otherwise.
    pub sourced_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionEnvResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// `server.session.env.apply` / `server.session.env.unset` — the server hands
/// the agent already-resolved snapshots (so parsing/source resolution is done
/// centrally) to apply or remove on a running session.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionEnvApplyPayload {
    pub request_id: String,
    pub name: String,
    pub snapshots: Vec<EnvSnapshot>,
    #[serde(default)]
    pub client_id: Option<String>,
    /// The env file refs being applied (for tracking purposes)
    #[serde(default)]
    pub env_files: Vec<EnvFileRef>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionEnvUnsetPayload {
    pub request_id: String,
    pub name: String,
    /// The variable keys to remove via `tmux set-environment -u`.
    pub keys: Vec<String>,
    #[serde(default)]
    pub client_id: Option<String>,
}

// ============================================================================
// Terminal resize events
// ============================================================================

/// Agent → Server: tmux session resized.
/// Agent parses tmux control mode `%window-resize` events and sends this
/// payload with the session id and new dimensions.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTerminalResizePayload {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Server → Client: broadcast terminal resize to all attached clients.
/// Reuses the message type name already used by CLI (`terminal.resize`).
/// The `session_id` lets each client route to its per-session callback —
/// clients may be attached to multiple sessions on the same WebSocket.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerTerminalResizePayload {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

// ============================================================================
// One-way agent → server reports
// ============================================================================

/// `server.agent.session-update` — the agent reports one tmux session's state.
///
/// One-way: the server applies it and answers **nothing on every branch**.
/// `handle_agent_session_update` has five exits and all five are
/// `Reply(None)` — two of them deliberate early-outs (unregistered agent,
/// unknown status), which is why "answers nothing" is not the same claim as
/// "always succeeds". No `.response` wire exists for this id anywhere.
///
/// Hoisted out of `nession-agent`'s `server_client.rs`, which declared it
/// privately beside the code that sends it. That is the drift the protocol
/// module's own doc warns about for `Message<P>` — *"two definitions of a
/// framing contract are two answers"* — and it is invisible for exactly as long
/// as the two agree.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSessionUpdatePayload {
    pub agent_id: String,
    pub session_name: String,
    /// One of `active`, `detached`, `recovering`, `orphaned`, `zombie`, `gone`.
    ///
    /// A `String` and not an enum, deliberately: the server matches these and
    /// *warns and returns* on anything else, so a closed enum here would
    /// describe a validation the server does not perform. The values are named
    /// so a reader does not have to go and find them.
    pub status: String,
    pub window_count: u32,
    pub attached_clients: u32,
    /// Foreground command of the session's active pane, when tmux reports one.
    ///
    /// `Option` on the wire as well as in the type: the server folds an empty
    /// string to `None` before storing it, so `""` and *absent* already mean the
    /// same thing downstream. The contract says so rather than leaving a caller
    /// to discover it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_command: Option<String>,
}

// ============================================================================
// The command/request_id protocol
// ============================================================================

/// `agent.session.report` — the Server asks an Agent to report its sessions.
///
/// Request-only, **because its answer is a different unit**. The agent replies
/// on `server.agent.command-response`, carrying
/// `{request_id, command, success, sessions}` — that is the entire point of the
/// `command`/`request_id` protocol, and it is why `server.agent.command-response`
/// is a unit of its own with a request and no response. Declaring a reply here
/// would describe a message nobody sends.
///
/// `request_id` is injected by `agent_command_with_timeout` at the Server, not
/// by the caller — it is the correlation key the broker matches the answer on,
/// and the arm reaches for it before it does anything else.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionReportPayload {
    pub request_id: String,
}

/// `server.session.relay.begin` — Phase 2 of relay attach.
///
/// Phase 1 (`server.session.attach`, relay mode) returned the candidate
/// addresses but did **not** enter relay forwarding. The browser sends this once
/// the Terminal is mounted and subscribed, and only then does data flow.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientRelayBeginPayload {
    /// `"<agent_id>:<session_name>"` — the same composite the rest of the tree
    /// uses, split by the handler with `split_once(':')`.
    pub session_id: String,
    /// Manual relay URL override. When present the server uses exactly this URL
    /// instead of ranking the agent's advertised addresses.
    ///
    /// Carries the ranking's *input*, not its output: the field is read before
    /// any address is examined, so on a manual override the address list is
    /// never touched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
    /// Terminal dimensions from the browser's `ResizeObserver`.
    ///
    /// Both default to 80×24 rather than being required: the browser may mount
    /// the Terminal before it has measured anything, and the handler has always
    /// tolerated that. Relaxed because the absence is already handled, not
    /// because a caller might forget.
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

/// `server.session.relay.end` — stop the relay without closing the WebSocket.
///
/// One-way, and **off the dispatcher entirely**: the route table's arm is a stub
/// returning `Reply(None)`, and the message is actually intercepted inside the
/// relay forwarding loop (`server/websocket.rs`) by a text match, which is where
/// it has to be — by then the connection is being pumped by two `async` blocks
/// and never returns to `handle_message`. So the shape is declared here for the
/// wire's sake while the routing lives there.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientRelayEndPayload {
    pub session_id: String,
}

// --- The peer-to-peer projection (#678) ---
//
// The same operations a browser asks a *server* for, spoken directly to an
// agent. One unit, several wires: `session.create` is served by the server for
// a browser and by the agent for one, and this is the agent's second
// projection of it.

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionInfo {
    pub name: String,
    pub created_at: u64,
    pub window_count: u32,
    pub attached_clients: u32,
    pub width: u16,
    pub height: u16,
    /// Foreground command of the session's active pane (`#{pane_current_command}`).
    ///
    /// Runtime observation, not durable session metadata: it changes as the user
    /// runs things, and it is absent when tmux reports nothing.
    pub foreground_command: Option<String>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCreatePayload {
    pub name: String,
    #[serde(default = "default_width")]
    pub width: u16,
    #[serde(default = "default_height")]
    pub height: u16,
    /// Resolved env-file snapshots to inject via `tmux new-session -e`.
    ///
    /// `ServerSessionCreatePayload` has carried this since the env feature
    /// landed; this projection did not, and the omission is what stopped the
    /// two being one protocol. `agent.session.create` is answered by the agent
    /// whichever side asks, so the two payloads have to be the same payload —
    /// and the difference was never a decision, just a field the direct path
    /// never grew.
    ///
    /// Empty (default) preserves the previous behaviour exactly for a caller
    /// that does not send it.
    #[serde(default)]
    pub env_snapshots: Vec<EnvSnapshot>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionKillPayload {
    pub name: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAttachPayload {
    pub session_name: String,
    #[serde(default = "default_width")]
    pub width: u16,
    #[serde(default = "default_height")]
    pub height: u16,
    /// Resolved env-file snapshots to apply via `tmux set-environment`
    /// before PTY creation. Empty (default) preserves pre-env behaviour.
    #[serde(default)]
    pub env_snapshots: Vec<EnvSnapshot>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientDetachPayload {
    pub session_name: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCapturePreviewPayload {
    pub session_name: String,
    pub lines: u32,
}

/// The client's request to `server.session.capture-preview`.
///
/// Distinct from [`SessionCapturePreviewPayload`] on purpose: that one is what
/// the *Server* sends the agent, and it names a `session_name`. The client sends
/// a `session_id` and may omit `lines`. The two halves of one protocol had
/// collided on a plausible name, which is why this is not called `…Payload`.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionCapturePreviewPayload {
    pub session_id: String,
    /// How much scrollback to capture. Absent means 2000 — the value the
    /// handler has always defaulted to.
    #[serde(default = "default_preview_lines")]
    pub lines: u32,
}

pub(crate) fn default_preview_lines() -> u32 {
    2000
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCapturePreviewResponse {
    pub ansi_b64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionInfo {
    pub session_id: String,
    pub agent_id: String,
    pub session_name: String,
    pub status: String,
    pub window_count: u32,
    pub attached_clients: u32,
    /// The active pane's current command. Runtime observation: it changes as
    /// the user runs things and tmux may report nothing.
    ///
    /// On the wire since the list existed; this type did not name it, so a
    /// consumer reading the schema could not know it was there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_command: Option<String>,
    pub last_activity: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionsListResponse {
    pub sessions: Vec<WebSessionInfo>,
    /// Agents that did not answer a forced refresh, so the caller knows the
    /// list may be incomplete rather than complete-but-empty. Always on this
    /// branch, and never declared until now.
    #[serde(default)]
    pub stale_agents: Vec<String>,
}

/// `client.sessions.list`'s request: empty, and explicitly so.
///
/// The same list as `agent.session.list`, asked at the browser's compat door.
/// It reads nothing off the payload either, and `request: None` would claim the
/// unit has no request rather than an empty one.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClientSessionsListPayload {}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionAttachPayload {
    pub session_id: String,
    #[serde(default = "default_attach_mode")]
    pub preferred_mode: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebAttachInfo {
    pub mode: String,
    pub session_id: String,
    pub session_name: String,
    pub agent_address: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionCreatePayload {
    pub agent_id: String,
    pub name: String,
    #[serde(default = "default_width")]
    pub width: u16,
    #[serde(default = "default_height")]
    pub height: u16,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionCreateResponse {
    pub success: bool,
    pub session_id: Option<String>,
    pub error: Option<String>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionKillPayload {
    pub session_id: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionKillResponse {
    pub success: bool,
    pub error: Option<String>,
}

/// What the Server says when it refuses a session request before answering it.
///
/// The Server has always sent this — eleven handlers reply
/// `{ "status": "error", "message": "…" }` — and no contract in the catalog
/// described it. Two consequences followed: a consumer reading the schema saw
/// only the success shape, and the *second* refusal convention in this tree
/// stayed invisible. The env family refuses with `{ success, error }`; this
/// family refuses with `{ status, message }`. Both are real, neither was
/// declared, and unifying them is a change to a shipped wire that this does not
/// attempt.
///
/// Per family rather than shared, deliberately: `contracts/mod.rs` places a
/// contract by the family its id names, and a cross-family type has no segment
/// to look up — it would be the `misc/` that rule exists to prevent. Two
/// families refusing alike may end up with two identical types; the refusals
/// already say different things, so that is also where a divergence would go.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRefusal {
    /// Always `"error"` today. A string rather than an enum because nothing
    /// branches on its other values yet, and inventing them would be describing
    /// a wire that does not exist.
    pub status: String,
    pub message: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionListResponse {
    pub sessions: Vec<SessionInfo>,
    /// Agents that did not answer a forced refresh, so the caller knows the
    /// list may be incomplete rather than complete-but-empty.
    ///
    /// Always on this branch — the handler builds it on both paths — and it was
    /// never declared. Its absence from the contract is why `stale_agents`
    /// looked like a field a consumer could not rely on; it is the opposite,
    /// it is always there and the caller is meant to act on it.
    #[serde(default)]
    pub stale_agents: Vec<String>,
}

/// `server.session.list`'s request.
///
/// Both fields optional: the handler reads a missing `agent_id` as "every
/// agent" and a missing `force` as false, and it did so before this type
/// existed. Declaring them required would turn requests the Server accepts into
/// refusals.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServerSessionListPayload {
    /// Scope the list to one agent. Absent means all of them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Ask every online agent for its live sessions before answering, rather
    /// than answering from the registry. Slower, and the reason `stale_agents`
    /// exists.
    #[serde(default)]
    pub force: bool,
}

/// `server.session.list`'s reply: the list, or the refusal.
///
/// Untagged because the two shapes are **disjoint** — no field is shared, so
/// there is nothing to discriminate on and nothing ambiguous to resolve.
/// Modelling them as one struct with optional fields would assert that
/// `sessions` and `status` can coexist, which they never do.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ServerSessionListReply {
    /// `WebSessionsListResponse`, not `SessionListResponse`. The two look like
    /// the same idea and are not: `session_to_json` sends
    /// `session_id`/`session_name`/`status`/`last_activity`, while
    /// `SessionInfo` uses `name`/`created_at`/`width`/`height`. Naming the
    /// wrong one would have asserted a shape the handler has never produced.
    Listed(WebSessionsListResponse),
    Refused(SessionRefusal),
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCreateResponse {
    pub name: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionKillResponse {
    pub name: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAttachResponse {
    pub session_name: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientDetachResponse {
    pub session_name: String,
}
