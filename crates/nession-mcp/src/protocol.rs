//! The MCP protocol versions and endpoint defaults (`#3264`).
//!
//! Nession is a **dual-era** server: every request declares its version, so
//! `2026-07-28` is served statelessly from per-request metadata while
//! `2025-03-26` keeps the legacy `initialize` handshake and `Mcp-Session-Id`
//! lifecycle. The wire grammar itself belongs to the official `rmcp` SDK; this
//! module only owns which versions Nession claims and the endpoint defaults.

/// The primary protocol revision this service implements.
pub const MODERN_PROTOCOL_VERSION: &str = "2026-07-28";

/// The legacy revision kept for existing MCP clients.
pub const LEGACY_PROTOCOL_VERSION: &str = "2025-03-26";

/// The versions this service claims, newest first.
///
/// Only versions with executed acceptance proof are listed: an advertised
/// version is a promise about its base semantics, not a capability guess.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] =
    &[MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION];

/// The endpoint path unless the host configures another.
pub const DEFAULT_PATH: &str = "/mcp";

/// The server name reported in `initialize` and `server/discover`.
pub const SERVER_NAME: &str = "nession";

/// Default tool-call deadline.
pub const DEFAULT_TOOL_TIMEOUT_SECS: u64 = 60;

/// Default bound on concurrent tool executions.
pub const DEFAULT_MAX_CONCURRENT_CALLS: usize = 16;

/// Default cache lifetime advertised for `tools/list`.
///
/// The registered catalog is fixed at startup, so this only bounds how long a
/// modern client may reuse it without asking again. It never varies per
/// principal.
pub const TOOLS_LIST_TTL_MS: u64 = 300_000;

/// Whether `version` is one this service claims.
pub fn supports_protocol_version(version: &str) -> bool {
    SUPPORTED_PROTOCOL_VERSIONS.contains(&version)
}
