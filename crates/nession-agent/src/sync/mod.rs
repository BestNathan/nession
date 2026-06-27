//! Synchronization module for the nession agent.
//!
//! Provides background tasks that keep the central server informed about
//! the agent's status and tmux session state:
//!
//! - [`heartbeat::HeartbeatLoop`] sends periodic heartbeats with system metrics.
//! - [`session_watcher::SessionWatcher`] polls tmux for session changes and
//!   sends incremental updates.

pub mod heartbeat;
pub mod session_watcher;
