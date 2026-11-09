//! Seatbelt profile generation for the one capability this backend verified:
//! network denial.
//!
//! Path allow-lists are **not** emitted. On the measured macOS version a
//! `(deny file-read* (require-not (subpath …)))` rule aborts the profile
//! compiler, and a `(deny default)` allow-list would have to enumerate every
//! loader path; claiming `filesystem.access` from that would be a guess. The
//! validator therefore rejects `filesystem.access` on macOS and reports the
//! limitation instead of silently approximating it.

use std::fmt::Write as _;

use nession_protocol::contracts::sandbox::v1::SandboxNetworkMode;

use crate::policy::CompiledNetwork;

/// Build the profile string for one execution.
pub fn build_profile(network: Option<&CompiledNetwork>) -> String {
    let mut profile = String::from("(version 1)\n(allow default)\n");
    if let Some(network) = network {
        if network.mode == SandboxNetworkMode::Deny {
            let _ = writeln!(profile, "(deny network*)");
        }
    }
    profile
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::compile;
    use nession_protocol::contracts::sandbox::v1::SandboxPolicy;

    fn compiled(value: serde_json::Value) -> crate::policy::CompiledSandboxPolicy {
        let policy: SandboxPolicy = serde_json::from_value(value).expect("fixture");
        compile(&policy).expect("compile")
    }

    #[test]
    fn network_deny_adds_the_network_rule_and_allow_does_not() {
        let deny = compiled(serde_json::json!({
            "enabled": true,
            "network": { "mode": "deny" }
        }));
        assert!(build_profile(deny.network.as_ref()).contains("(deny network*)"));
        let allow = compiled(serde_json::json!({
            "enabled": true,
            "network": { "mode": "allow" }
        }));
        assert!(!build_profile(allow.network.as_ref()).contains("(deny network*)"));
    }

    #[test]
    fn no_path_allow_list_is_claimed() {
        let compiled = compiled(serde_json::json!({
            "enabled": true,
            "network": { "mode": "deny" }
        }));
        let profile = build_profile(compiled.network.as_ref());
        assert!(!profile.contains("file-read*"));
        assert!(!profile.contains("file-write*"));
        assert!(profile.contains("(allow default)"));
    }
}
