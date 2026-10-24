//! Utility modules for CLI commands.
//!
//! This module contains shared utilities used by agent, server, and client
//! commands, including PID file management, process monitoring, and the
//! background-start credential handoff.

pub mod pid_file;
pub mod process;
pub mod secret_handoff;
pub mod startup;
