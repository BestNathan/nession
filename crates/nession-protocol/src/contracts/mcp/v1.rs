//! Extension-contributed MCP Tool capability contracts (`#3778`).
//!
//! An Agent advertises the Tools its Extensions contribute; the Server stores
//! and validates that manifest and routes an authorized call to the owning
//! Agent. The Tool's semantics stay with its Extension, and `nession-mcp` owns
//! the MCP protocol and the typed Tool contract (`#3264`, `#3735`).
//!
//! These are capability contracts, not provider implementations: they carry the
//! **exact** `inputSchema`/`outputSchema` a contributed Tool advertises, so the
//! same Tool name means the same contract in every hosting mode. Freshness is
//! the manifest version: a receiver that does not know the version refuses that
//! manifest rather than guessing.

use serde::{Deserialize, Serialize};

/// The manifest shape this build can validate.
pub const MCP_TOOL_MANIFEST_VERSION: u32 = 1;

/// One Extension-contributed MCP Tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct McpToolDescriptor {
    /// The exact MCP Tool name, unique across the whole advertised catalog.
    pub name: String,
    /// The Extension that owns this Tool's semantics.
    pub provider: String,
    /// What the Tool answers and which owner it belongs to.
    pub description: String,
    /// The Tool's typed argument schema, verbatim.
    #[cfg_attr(feature = "codegen", ts(type = "unknown"))]
    pub input_schema: serde_json::Value,
    /// The Tool's typed success-output schema, verbatim.
    #[cfg_attr(feature = "codegen", ts(type = "unknown"))]
    pub output_schema: serde_json::Value,
}

/// What one Agent's Extensions contribute to the shared MCP endpoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct McpToolManifest {
    /// The manifest contract version the sender used.
    pub manifest_version: u32,
    /// Contributed Tools in composition order.
    pub tools: Vec<McpToolDescriptor>,
}

impl McpToolManifest {
    /// A version-1 manifest over the given Tools.
    pub fn new(tools: Vec<McpToolDescriptor>) -> Self {
        Self {
            manifest_version: MCP_TOOL_MANIFEST_VERSION,
            tools,
        }
    }

    /// Whether a receiver can validate this manifest.
    pub fn is_supported(&self) -> bool {
        self.manifest_version == MCP_TOOL_MANIFEST_VERSION
    }

    /// The Tool with this exact name, when the manifest advertises one.
    pub fn tool(&self, name: &str) -> Option<&McpToolDescriptor> {
        self.tools.iter().find(|tool| tool.name == name)
    }
}

/// `server.mcp.tools.list` request: read the Server's validated capability
/// manifest. Empty by construction.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct McpToolsListRequest {}

/// `server.mcp.tools.list` reply: the catalog the Server would advertise to an
/// MCP client, without liveness. A Tool stays listed while its owning Agent is
/// offline; execution answers the truth for the named target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct McpToolsListResponse {
    /// The validated merged manifest.
    pub manifest: McpToolManifest,
}

/// One authorized call of an Extension-contributed Tool.
///
/// `agent_id` is explicit and non-empty in every hosting mode, including
/// Agent-embedded: the Tool always acts on the named Agent and never on "the
/// host that happens to answer".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct McpToolCallPayload {
    /// The owning Agent the caller explicitly names.
    pub agent_id: String,
    /// The contributed Tool name.
    pub tool: String,
    /// The Tool's arguments, validated by its owner.
    #[cfg_attr(feature = "codegen", ts(type = "unknown"))]
    pub arguments: serde_json::Value,
}

/// The owner's answer to one contributed Tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct McpToolCallReply {
    /// Whether the Tool returned a success reply.
    pub success: bool,
    /// The Tool's structured success value, when `success`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "unknown"))]
    pub result: Option<serde_json::Value>,
    /// A stable refusal, when not `success`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<McpToolCallError>,
}

impl McpToolCallReply {
    /// A successful Tool result.
    pub fn success(result: serde_json::Value) -> Self {
        Self {
            success: true,
            result: Some(result),
            error: None,
        }
    }

    /// A refusal with a stable kind (`unavailable`, `not_found`, `timeout`,
    /// `invalid_argument`, `backend`).
    pub fn failure(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            success: false,
            result: None,
            error: Some(McpToolCallError {
                kind: kind.into(),
                message: message.into(),
            }),
        }
    }
}

/// A stable contributed-Tool refusal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct McpToolCallError {
    /// The refusal kind, matching the MCP Tool error vocabulary.
    pub kind: String,
    /// The owner's message; never contains a credential.
    pub message: String,
}
