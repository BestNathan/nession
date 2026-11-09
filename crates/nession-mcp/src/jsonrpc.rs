//! The MCP transport's JSON-RPC 2.0 surface.
//!
//! Deliberately small: MCP 2025-03-26 uses JSON-RPC for requests, replies and
//! notifications, and batching is part of that version. The types here are the
//! wire shapes only; lifecycle rules belong to [`crate::service`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A JSON-RPC id: number or string, per the specification.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Id {
    /// Numeric id.
    Number(i64),
    /// String id.
    String(String),
}

/// One request or notification.
#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    /// Must be `"2.0"`.
    pub jsonrpc: String,
    /// Absent for a notification.
    #[serde(default)]
    pub id: Option<Id>,
    /// The method name.
    pub method: String,
    /// Method parameters.
    #[serde(default)]
    pub params: Option<Value>,
}

impl Request {
    /// Whether this message is a notification (no id, no reply).
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }
}

/// One successful reply.
#[derive(Debug, Clone, Serialize)]
pub struct SuccessResponse {
    /// Always `"2.0"`.
    pub jsonrpc: &'static str,
    /// Echoed request id.
    pub id: Option<Id>,
    /// The method result.
    pub result: Value,
}

/// One error reply.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorResponse {
    /// Always `"2.0"`.
    pub jsonrpc: &'static str,
    /// Echoed request id; `null` when the request could not be parsed.
    pub id: Option<Id>,
    /// The error object.
    pub error: ErrorObject,
}

/// The JSON-RPC error member.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorObject {
    /// Standard JSON-RPC or MCP error code.
    pub code: i64,
    /// A short sentence.
    pub message: String,
    /// Optional structured detail.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ErrorResponse {
    /// Build an error reply.
    pub fn new(id: Option<Id>, code: i64, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            error: ErrorObject {
                code,
                message: message.into(),
                data: None,
            },
        }
    }

    /// Attach structured detail.
    pub fn with_data(mut self, data: Value) -> Self {
        self.error.data = Some(data);
        self
    }
}

/// Standard JSON-RPC error codes this service uses.
pub mod codes {
    /// The body was not valid JSON.
    pub const PARSE_ERROR: i64 = -32700;
    /// The JSON was valid but not a JSON-RPC request.
    pub const INVALID_REQUEST: i64 = -32600;
    /// The method does not exist.
    pub const METHOD_NOT_FOUND: i64 = -32601;
    /// The method parameters are invalid.
    pub const INVALID_PARAMS: i64 = -32602;
    /// The server did not finish initialising.
    pub const SERVER_NOT_INITIALIZED: i64 = -32002;
}
