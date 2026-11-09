//! The MCP protocol version and lifecycle constants.

/// The Streamable HTTP revision this service implements.
///
/// `2025-03-26` is the first revision that defines Streamable HTTP, and it is
/// what current MCP clients negotiate. A client asking for another version is
/// answered with this one; the client then decides whether it can proceed, as
/// the specification requires.
pub const PROTOCOL_VERSION: &str = "2025-03-26";

/// The versions this service can answer with.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[PROTOCOL_VERSION];

/// The endpoint path unless the host configures another.
pub const DEFAULT_PATH: &str = "/mcp";

/// The server name reported in `initialize`.
pub const SERVER_NAME: &str = "nession";

/// Default tool-call deadline.
pub const DEFAULT_TOOL_TIMEOUT_SECS: u64 = 60;

/// Default bound on concurrent tool executions.
pub const DEFAULT_MAX_CONCURRENT_CALLS: usize = 16;

/// Default MCP session idle lifetime.
pub const DEFAULT_SESSION_IDLE_SECS: u64 = 3600;

/// Default bound on live MCP sessions.
pub const DEFAULT_MAX_SESSIONS: usize = 4096;
