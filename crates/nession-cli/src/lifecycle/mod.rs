//! Daemon lifecycle primitives shared by every `agent`/`server` command.
//!
//! PID identity and ownership (#1016), process observation, acknowledged
//! readiness markers, and the background-start credential handoff (#2269).
//! Commands consume these owners; they do not carry copies of them.

pub mod pid_file;
pub mod process;
pub mod secret_handoff;
pub mod startup;
