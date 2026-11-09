//! The one error shape a tool backend can produce.
//!
//! A backend failure is a *tool execution* failure: MCP carries it in a
//! `tools/call` result with `isError: true`, not as a JSON-RPC transport error.
//! The kinds exist so the text a model reads is stable across the three
//! hosting modes instead of three hosts inventing three sentences.

/// What kind of failure a tool call hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolErrorKind {
    /// The caller's arguments are missing or malformed.
    InvalidArgument,
    /// A named resource does not exist.
    NotFound,
    /// The backend cannot be reached right now.
    Unavailable,
    /// The backend accepted the call but did not answer in time.
    Timeout,
    /// The backend answered with a refusal.
    Backend,
}

impl ToolErrorKind {
    /// The stable machine-readable spelling carried in the tool result.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArgument => "invalid_argument",
            Self::NotFound => "not_found",
            Self::Unavailable => "unavailable",
            Self::Timeout => "timeout",
            Self::Backend => "backend",
        }
    }
}

/// A tool call failure with a caller-facing sentence.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ToolError {
    /// The stable classification.
    pub kind: ToolErrorKind,
    /// The sentence a model or operator reads. Never contains a credential.
    pub message: String,
}

impl ToolError {
    /// Build one.
    pub fn new(kind: ToolErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// The requested argument is missing or malformed.
    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(ToolErrorKind::InvalidArgument, message)
    }

    /// A named resource does not exist.
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ToolErrorKind::NotFound, message)
    }

    /// The backend cannot be reached right now.
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(ToolErrorKind::Unavailable, message)
    }

    /// The backend did not answer in time.
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ToolErrorKind::Timeout, message)
    }

    /// The backend answered with a refusal.
    pub fn backend(message: impl Into<String>) -> Self {
        Self::new(ToolErrorKind::Backend, message)
    }
}
