use thiserror::Error;

#[derive(Error, Debug)]
pub enum NessionError {
    #[error("Authentication failed: {0}")]
    AuthFailed(String),

    #[error("Agent not found: {0}")]
    AgentNotFound(String),

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Invalid message format: {0}")]
    InvalidMessage(String),

    #[error("Database error: {0}")]
    DatabaseError(String),

    #[error("WebSocket error: {0}")]
    WebSocketError(String),

    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, NessionError>;
