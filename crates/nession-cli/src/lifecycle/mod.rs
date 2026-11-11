//! Daemon lifecycle primitives shared by every `agent`/`server` command.
//!
//! PID identity and ownership (#1016), process observation, acknowledged
//! readiness markers, and the background-start credential handoff (#2269).
//! Commands consume these owners; they do not carry copies of them.

pub mod lock;
pub mod pid_file;
pub mod process;
pub mod release;
pub mod secret_handoff;
pub mod startup;
pub mod terminate;

/// The shared lifecycle contract advertised by a release's CLI.
///
/// A selected (archived) release that cannot answer `--lifecycle-contract`
/// with this token and its own compiled version does not share the lifecycle
/// lock, PID identity and single-active gate. The version dispatcher refuses
/// `agent|server start/restart/status/stop` for such a release instead of
/// executing it blindly (#3232 F2).
pub const CONTRACT_TOKEN: &str = "nession-lifecycle-v1";

/// The exact stdout line a contract-aware CLI prints for the probe.
pub fn contract_line() -> String {
    format!("{CONTRACT_TOKEN} {}", env!("CARGO_PKG_VERSION"))
}
