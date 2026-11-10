//! Sandbox failure taxonomy.
//!
//! The variants exist because callers must distinguish "the request is not
//! valid" from "this host cannot honour it" from "it was honoured and then we
//! could not prove or clean it up". A fallback to Native is never one of the
//! outcomes: the Agent refuses the create instead.

/// One sandbox operation failure.
#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    /// The policy schema is well-formed but semantically invalid.
    #[error("invalid sandbox policy: {0}")]
    InvalidPolicy(String),
    /// The policy asks for a guarantee this platform/backend cannot install.
    #[error("unsupported sandbox policy: {0}")]
    UnsupportedPolicy(String),
    /// Explicitly requested implementations/options the host cannot install.
    /// The field paths are canonical policy paths for the caller to render.
    #[error("unsupported sandbox policy requests: {}", .0.iter().map(|field| format!("{}: {}", field.field, field.message)).collect::<Vec<_>>().join("; "))]
    UnsupportedRequests(Vec<nession_protocol::contracts::sandbox::v1::SandboxFieldError>),
    /// The host cannot provide the backend at all (no helper, no delegation).
    #[error("sandbox backend unavailable: {0}")]
    BackendUnavailable(String),
    /// A host resource required by the launch could not be prepared.
    #[error("sandbox preparation failed: {0}")]
    Prepare(String),
    /// The launch happened but the required guarantees were not observed.
    #[error("sandbox launch verification failed: {0}")]
    Verify(String),
    /// Owned resources could not be released; the record is kept.
    #[error("sandbox cleanup failed: {0}")]
    Cleanup(String),
}

/// The crate's result type.
pub type Result<T> = std::result::Result<T, SandboxError>;
