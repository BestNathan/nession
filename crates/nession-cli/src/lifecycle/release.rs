//! Cross-component release compatibility for lifecycle commands.
//!
//! Agent and Server are single-active components. They may run different
//! releases only when the operator explicitly replaces one; a `start`/`restart`
//! must never silently create a mixed-release environment, and it must never
//! restart the other component to "fix" the mismatch. This module owns that
//! refusal so agent and server commands ask the same question.

use crate::lifecycle::pid_file::{self, Component};
use anyhow::{bail, Result};

/// The release this CLI process belongs to.
pub fn this_release() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Refuse to start `starting` when `peer` is already running a different
/// release (or one whose release cannot be proven).
///
/// Same-release peers are compatible. A missing peer is not a conflict.
pub fn ensure_no_mixed_release(peer: Component, starting: Component) -> Result<()> {
    let Some((path, identity)) = pid_file::default_live(peer)? else {
        return Ok(());
    };
    let mine = this_release();
    match identity.release_version.as_deref() {
        Some(version) if version == mine => Ok(()),
        Some(version) => bail!(
            "{} {} is running release {version} (PID {}, state file {path}); starting {} \
             release {mine} would create a mixed-release environment.\n\
             Fix: restart the {} with release {mine}, or stop it first. Nession does not \
             restart the other component implicitly.",
            peer.as_str(),
            if peer == Component::Agent {
                "Agent"
            } else {
                "Server"
            },
            identity.pid,
            starting.as_str(),
            peer.as_str()
        ),
        None => bail!(
            "{} {} is running a release it did not record (PID {}, state file {path}); \
             cannot prove it matches {} release {mine}.\n\
             Fix: restart the {} with release {mine}, or stop it first.",
            peer.as_str(),
            if peer == Component::Agent {
                "Agent"
            } else {
                "Server"
            },
            identity.pid,
            starting.as_str(),
            peer.as_str()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_release_is_semver() {
        assert!(semver::Version::parse(this_release()).is_ok());
    }

    #[test]
    fn a_component_is_its_own_peer_label() {
        // The policy compares the *recorded* release string; the label only
        // shapes the diagnostic. Pin the mapping used in the error text.
        assert_eq!(Component::Agent.as_str(), "agent");
        assert_eq!(Component::Server.as_str(), "server");
    }
}
