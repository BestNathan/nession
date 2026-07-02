//! Terminal handling for `nession session attach`.
//!
//! This module provides raw terminal mode management and bidirectional I/O
//! forwarding between the local terminal and the remote agent via WebSocket.

pub mod raw;

pub use raw::{TerminalSession, TerminalTransport};
