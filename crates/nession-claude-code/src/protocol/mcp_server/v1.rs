//! `claude-code.mcp-server` / v1 (#3600).
//!
//! One explicitly named MCP entry, and — only when the caller asks for it — a
//! bounded capability discovery against that entry.
//!
//! ## Opening the view never contacts anything
//!
//! `probe` defaults to false. With it false this unit reads the same
//! configuration files the inventory reads and answers from them. It does not
//! run a health check, start a stdio process, open a socket, or call
//! `tools/list`.
//!
//! ## Consent is part of the request
//!
//! A stdio server is a local process. Discovering its Tools is therefore an
//! explicit second decision: `probe: true` for a stdio entry is refused with
//! `consent_required` unless `allow_stdio` is also true. An HTTP/SSE discovery
//! request is bounded by time and bytes, and never issues `tools/call`.
//!
//! ## The answer says where it came from
//!
//! A successful probe is "this server answered this endpoint from this
//! process right now". It is **not** "the running Claude session has loaded
//! these Tools". The entry keeps `load_state: unknown`, and the probe carries
//! its own source and status so a client cannot present the first as the
//! second.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::mcp_servers::v1::{McpScopeV1, McpServerEntryV1, McpTransportV1};
use crate::protocol::v1_descriptor;

pub const WIRE: &str = "claude-code.mcp-server";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpServerRequestV1 {
    /// Required: the entry is resolved in this Session's Claude context.
    pub session_id: String,
    /// The entry name. Names are unique per scope, not across scopes.
    pub name: String,
    /// Disambiguates a name configured in more than one scope. Absent means the
    /// effective definition, which is the one Claude would load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<McpScopeV1>,
    /// Ask for bounded capability discovery. Never implied by opening the view.
    #[serde(default)]
    pub probe: bool,
    /// Explicit consent to start a stdio server for that discovery.
    #[serde(default)]
    pub allow_stdio: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpServerStateV1 {
    Ready,
    NotFound,
    Unavailable,
    Unsupported,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpProbeStatusV1 {
    /// The caller did not ask; the entry was read, not contacted.
    NotRequested,
    /// A discovery connection completed and returned capabilities.
    Ok,
    /// This build cannot inspect that transport.
    Unsupported,
    /// The server or the local policy refused the discovery.
    Refused,
    /// The connection or handshake failed. Distinct from an empty success.
    Failed,
    /// A bound was reached; the lists are a valid prefix.
    Truncated,
}

/// What actually answered the discovery call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpProbeSourceV1 {
    Http,
    Stdio,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpToolV1 {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The `inputSchema` the server advertised, serialised and bounded. A
    /// string rather than an arbitrary JSON value so the generated Web binding
    /// stays a closed shape; the client parses it only to render.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpResourceV1 {
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpPromptV1 {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpProbeResultV1 {
    pub status: McpProbeStatusV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<McpProbeSourceV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<McpTransportV1>,
    /// Capability names the server advertised (`tools`, `resources`, `prompts`).
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub tools: Vec<McpToolV1>,
    #[serde(default)]
    pub resources: Vec<McpResourceV1>,
    #[serde(default)]
    pub prompts: Vec<McpPromptV1>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl McpProbeResultV1 {
    pub fn not_requested() -> Self {
        Self {
            status: McpProbeStatusV1::NotRequested,
            source: None,
            transport: None,
            capabilities: Vec::new(),
            tools: Vec::new(),
            resources: Vec::new(),
            prompts: Vec::new(),
            truncated: false,
            error: None,
            detail: None,
        }
    }

    pub fn status_only(status: McpProbeStatusV1, error: impl Into<String>) -> Self {
        Self {
            status,
            error: Some(error.into()),
            ..Self::not_requested()
        }
    }

    pub fn from_source(source: McpProbeSourceV1, transport: McpTransportV1) -> Self {
        Self {
            status: McpProbeStatusV1::Ok,
            source: Some(source),
            transport: Some(transport),
            ..Self::not_requested()
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpServerResponseV1 {
    pub state: McpServerStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<McpServerEntryV1>,
    pub probe: McpProbeResultV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl McpServerResponseV1 {
    pub fn bare(state: McpServerStateV1) -> Self {
        Self {
            state,
            server: None,
            probe: McpProbeResultV1::not_requested(),
            error: None,
        }
    }

    pub fn with_error(state: McpServerStateV1, error: impl Into<String>) -> Self {
        Self {
            error: Some(error.into()),
            ..Self::bare(state)
        }
    }

    pub fn entry(mut self, entry: McpServerEntryV1) -> Self {
        self.server = Some(entry);
        self
    }

    pub fn probe(mut self, probe: McpProbeResultV1) -> Self {
        self.probe = probe;
        self
    }
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn probe_defaults_off_and_stdio_consent_defaults_off() {
        let request: McpServerRequestV1 =
            serde_json::from_value(json!({"session_id": "agent:s", "name": "github"})).unwrap();
        assert!(!request.probe);
        assert!(!request.allow_stdio);
        assert_eq!(request.scope, None);
    }

    #[test]
    fn a_probe_that_was_not_asked_for_is_not_an_empty_success() {
        let value = serde_json::to_value(McpProbeResultV1::not_requested()).unwrap();
        assert_eq!(value["status"], "not_requested");
        assert!(value["tools"].as_array().unwrap().is_empty());
        assert!(value.get("error").is_none());
    }

    #[test]
    fn a_probe_names_its_source_and_transport() {
        let probe = McpProbeResultV1::from_source(McpProbeSourceV1::Http, McpTransportV1::Http);
        let value = serde_json::to_value(probe).unwrap();
        assert_eq!(value["status"], "ok");
        assert_eq!(value["source"], "http");
        assert_eq!(value["transport"], "http");
    }

    #[test]
    fn a_bare_answer_keeps_the_probe_shape() {
        let value =
            serde_json::to_value(McpServerResponseV1::bare(McpServerStateV1::NotFound)).unwrap();
        assert_eq!(value["state"], "not_found");
        assert_eq!(value["probe"]["status"], "not_requested");
    }
}
