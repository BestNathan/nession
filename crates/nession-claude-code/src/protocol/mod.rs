//! This provider's protocol contracts (#678).
//!
//! ```text
//! protocol/
//!   conversation/v1
//!   list/v1
//!   read/v1
//! ```
//!
//! A directory per Protocol Unit, a file per contract version — the same layout
//! `nession-git` uses, for the reason recorded there: a v2 goes beside `v1.rs`
//! and `v1.rs` is never edited to express it.
//!
//! ## The id, the wire and the dispatch key are one string
//!
//! They used to be three, and this provider was where that showed. The wire
//! carried an `extension.` namespace the registry stripped before dispatching,
//! and it spelled the provider `claude_code` where `ProtocolId` refuses
//! underscores — so the id, the message type and the string the handler matched
//! on all differed, and this crate translated between them.
//!
//! The namespace is gone and the wire is the id, so the three collapsed onto
//! `claude-code.read`. Nothing is stripped and nothing is rewritten: the
//! registry hands the provider exactly the name it declared.
//! `the_wire_is_the_protocol_id` pins it. `nession-git`'s ids always happened to
//! match their suffixes, which used to look like a coincidence of naming rather
//! than the rule it turned out to be.
//!
//! ## The failure vocabulary differs from git's, and this does not change it
//!
//! `nession-git` answers failures as `state: unavailable | not_a_repository |
//! error`; this provider answers `{ error: "access_denied" }` and
//! `{ available: false }`. Two providers, two vocabularies for the same
//! concept, and the Web client has to branch on both.
//!
//! Typing a contract is not a contract version bump, so this migration keeps
//! each provider's shapes **exactly as they ship**. Unifying the vocabulary is
//! a wire change that needs a new contract version and a client update in the
//! same change, and it is recorded as such rather than smuggled in here.

pub mod conversation;
pub mod list;
pub mod read;

use nession_protocol::{ContractDescriptor, ContractVersion, IdentityError, ProtocolDescriptor};

/// This provider's identity in a manifest.
pub const OWNER: &str = "nession-claude-code";

/// Every contract this provider offers.
///
/// Fallible for the reason `nession-git`'s is: a provider that cannot name its
/// own contracts should fail at composition, not panic in whichever thread
/// happened to compose it.
pub fn descriptors() -> Result<Vec<ProtocolDescriptor>, IdentityError> {
    Ok(vec![list::descriptor()?, read::descriptor()?])
}

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

    const EXPECTED_IDS: [&str; 2] = ["claude-code.list", "claude-code.read"];

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
    fn the_wire_is_the_protocol_id() {
        // This asserted the opposite — that the wire's suffix was *not* the id —
        // and pinning it was right while it was true: the id cannot hold an
        // underscore, the wire did, and the two could never be equal.
        //
        // It stopped being true when the namespace went, and the underscore went
        // with it. The distinction had no job left: it existed so the registry
        // could strip a prefix that no longer exists.
        assert_eq!(list::v1::WIRE, list::ID);
        assert_eq!(list::ID, "claude-code.list");
    }

    #[test]
    fn a_descriptor_list_is_what_a_manifest_would_advertise() {
        let manifest =
            nession_protocol::ProtocolManifest::from_descriptors(OWNER, &descriptors().unwrap());
        assert_eq!(manifest.protocols.len(), EXPECTED_IDS.len());
        for id in EXPECTED_IDS {
            let id = nession_protocol::ProtocolId::new(id).unwrap();
            assert!(manifest.offers(&id), "manifest is missing {id}");
        }
    }
}
