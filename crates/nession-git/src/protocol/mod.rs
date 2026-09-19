//! This provider's protocol contracts (#678).
//!
//! ```text
//! protocol/
//!   status/v1
//!   diff/v1
//!   root/v1
//!   log/v1
//!   branches/v1
//!   worktrees/v1
//! ```
//!
//! A directory per Protocol Unit, a file per contract version. The layout is
//! the design's, and it is load-bearing rather than decorative: when `status`
//! needs a v2, the new contract is a file **beside** `v1.rs` and the old one is
//! not edited — which is the whole rule, made visible in the tree instead of
//! depending on someone remembering it.
//!
//! ## Why the contracts live here and not in the kernel
//!
//! `nession-protocol` owns the mechanism; this crate owns `git.status`. The
//! crate that implements a contract is the only one that can answer "what
//! changed?" when it moves, and a central DTO repository cannot — which is why
//! the Server's generic relay depends on no provider crate at all.
//!
//! ## What a contract module contains
//!
//! - the typed request and response;
//! - the descriptor naming the owner, the version and the wire message type;
//! - the response's failure states as variants, so a failure that needs a
//!   `reason` cannot be built without one.
//!
//! The wire shapes are **unchanged** by this migration. Typing a contract is
//! not a contract version bump: the design's table upgrades the version for a
//! changed field, a changed unit, changed error semantics — not for moving
//! `json!` into a struct that emits identical bytes.

pub mod branches;
pub mod diff;
pub mod log;
pub mod root;
pub mod status;
pub mod worktrees;

use serde::Serialize;

use nession_protocol::{ContractDescriptor, ContractVersion, IdentityError, ProtocolDescriptor};

/// This provider's identity in a manifest.
pub const OWNER: &str = "nession-git";

/// What a caller must say to reach this provider.
///
/// `session` and nothing else: the repository is resolved agent-side from the
/// Session's live working directory, and a client-supplied path is deliberately
/// ignored rather than rejected (`#750` C2). `agent_id` is absent because it is
/// **routing** — the server consumes it to pick an agent — and a request shape
/// that carried it would suggest the provider could address another agent.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SessionTargetV1 {
    pub session: String,
}

/// The four answers a git operation can give.
///
/// These are not one failure state with different text. "git is not installed",
/// "this directory is not a repository" and "the read failed" have different
/// causes and different fixes, which is what `#750` SC4 required be tellable
/// apart — so they are separate variants rather than a `kind` string on a
/// single error.
///
/// Internally tagged on `state`, which is exactly the shape the provider
/// already emitted by hand. Typing it is not a contract change: the bytes are
/// identical, and every variant that needs a `reason` cannot now be built
/// without one.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum GitResponseV1<T> {
    Ok {
        #[serde(flatten)]
        data: T,
    },
    /// git is present but this Session cannot be addressed, or the tool host is
    /// unwell. `reason` is machine-readable; `message` is for a person.
    Unavailable {
        reason: String,
        message: String,
    },
    /// An answer, not an error — `git init` and nothing else is a repository.
    NotARepository {
        message: String,
    },
    Error {
        message: String,
    },
}

/// A failure before an operation has an `Ok` shape to name.
///
/// `GitResponseV1<T>` is generic over the success payload, and the checks that
/// produce failures run *before* a handler knows which payload it would have
/// returned. This is the same three states without the parameter, so the shared
/// checks can return one value and each handler maps it in a line.
#[derive(Debug, Clone)]
pub enum GitFailure {
    Unavailable { reason: String, message: String },
    NotARepository { message: String },
    Error { message: String },
}

impl GitFailure {
    /// The shape every call site uses, so the three states cannot drift apart
    /// across six operations.
    pub fn into_response<T>(self) -> GitResponseV1<T> {
        match self {
            Self::Unavailable { reason, message } => GitResponseV1::Unavailable { reason, message },
            Self::NotARepository { message } => GitResponseV1::NotARepository { message },
            Self::Error { message } => GitResponseV1::Error { message },
        }
    }
}

/// Every contract this provider offers.
///
/// The list is what a runtime derives its manifest from, so a contract that is
/// declared here but wired to no handler is a manifest that advertises
/// something nobody can call — which is why the registry validates that pairing
/// rather than trusting this list.
///
/// Fallible, and not papered over with an `expect`: the workspace denies
/// `expect_used`, and it is right to here. A provider that cannot name its own
/// contracts should fail at composition — which is what the design asks for
/// (`invalid manifest declaration -> error`) — rather than panic in whichever
/// thread happened to compose it.
pub fn descriptors() -> Result<Vec<ProtocolDescriptor>, IdentityError> {
    Ok(vec![
        status::descriptor()?,
        diff::descriptor()?,
        root::descriptor()?,
        log::descriptor()?,
        branches::descriptor()?,
        worktrees::descriptor()?,
    ])
}

/// One version, one wire message type. Shared by every unit here because they
/// are all shaped alike; a unit that needs something else states it itself.
pub(crate) fn v1_descriptor(id: &str, wire: &str) -> Result<ProtocolDescriptor, IdentityError> {
    ProtocolDescriptor::new(
        id,
        OWNER,
        vec![ContractDescriptor::new(ContractVersion::V1, &[wire])],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ids this provider's descriptors are built from, in source order.
    ///
    /// These are what `v1_descriptor` validates, so asserting them here names
    /// the offending id instead of leaving it to whichever caller composes
    /// first.
    const EXPECTED_IDS: [&str; 6] = [
        "git.status",
        "git.diff",
        "git.root",
        "git.log",
        "git.branches",
        "git.worktrees",
    ];

    #[test]
    fn provider_contract_ids_are_canonical() {
        for id in EXPECTED_IDS {
            assert!(
                nession_protocol::ProtocolId::new(id).is_ok(),
                "{id} is not a canonical protocol id"
            );
        }
    }

    #[test]
    fn every_descriptor_is_self_consistent_and_owned_by_this_crate() {
        let descriptors = descriptors().unwrap();
        assert_eq!(descriptors.len(), EXPECTED_IDS.len());
        for descriptor in &descriptors {
            assert_eq!(descriptor.owner, OWNER);
            descriptor
                .validate()
                .unwrap_or_else(|e| panic!("{} is not self-consistent: {e}", descriptor.id));
        }
    }

    #[test]
    fn no_two_units_claim_the_same_wire_type() {
        // The failure this rules out is two contracts reachable by one message
        // type, which would leave the transport unable to tell which arrived.
        let mut seen: Vec<String> = Vec::new();
        for descriptor in descriptors().unwrap() {
            for contract in &descriptor.contracts {
                for wire in &contract.wire {
                    assert!(
                        !seen.contains(wire),
                        "`{wire}` is claimed by more than one contract"
                    );
                    seen.push(wire.clone());
                }
            }
        }
    }

    #[test]
    fn a_descriptor_list_is_what_a_manifest_would_advertise() {
        // Six units, one version each — the manifest a composed git provider
        // produces, and the thing the Server can route without knowing any
        // payload schema.
        let manifest =
            nession_protocol::ProtocolManifest::from_descriptors(OWNER, &descriptors().unwrap());
        assert_eq!(manifest.protocols.len(), 6);
        for id in EXPECTED_IDS {
            let id = nession_protocol::ProtocolId::new(id).unwrap();
            assert!(manifest.offers(&id), "manifest is missing {id}");
        }
    }
}
