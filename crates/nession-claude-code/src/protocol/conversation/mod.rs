//! `claude-code.conversation` — one Nession Session's Claude conversation,
//! normalized and paged.
//!
//! Two contract generations, one wire. `v1` is what shipped with #1005 and is
//! left byte-identical; `v2` (#1167) structures the same conversation so a
//! client can render it as prose, code and tool activity rather than as a
//! transcript of records. The wire locates the unit and `contract_version`
//! selects the generation — see `docs/architecture/protocol.md`, "One wire,
//! several generations", and note that `claude-code.conversation.v2` would be a
//! second name for one identity and is not a legal spelling.

pub mod v1;
pub mod v2;

pub use v1::{
    ConversationCandidateV1, ConversationIdentityV1, ConversationItemV1, ConversationRequestV1,
    ConversationResponseV1, ConversationStateV1, ItemKindV1, ToolV1, DEFAULT_ITEM_LIMIT,
    ITEM_CEILING, TOOL_SUMMARY_CEILING,
};
pub use v2::{
    ConversationCandidateV2, ConversationContentV2, ConversationIdentityV2, ConversationItemV2,
    ConversationRequestV2, ConversationResponseV2, ConversationStateV2, PayloadKindV2, PayloadV2,
    RoleV2, ToolStatusV2, ToolV2,
};

pub const ID: &str = "claude-code.conversation";

/// What the registry hands `handle_command`.
///
/// The same string as `ID`, as `v1::WIRE` and as `v2::WIRE` — the wire *is* the
/// protocol id, so there is nothing to translate. Several names for one string
/// because they answer different questions: identity, dispatch key, transport
/// projection. A version is not one of them.
pub const COMMAND: &str = "claude-code.conversation";

use nession_protocol::{ContractDescriptor, ContractVersion, IdentityError, ProtocolDescriptor};

/// This unit's identity, with **both** generations on its one wire.
///
/// One descriptor holding two contracts, rather than two descriptors: the
/// manifest keys by unit, and a consumer asking "what does this target offer for
/// `claude-code.conversation`?" must get `[1, 2]` from one answer. This is the
/// shape `crates/nession-agent`'s `Versioned` fixture establishes, and the one
/// `ProtocolManifest::from_descriptors` unions into a single entry.
///
/// Retiring v1 — mark `Deprecated`, move consumers, then `Retired` — is the
/// documented path (`docs/architecture/protocol.md`, "Retire a contract") and is
/// deliberately not done here: v1 is still served, and removing it in the same
/// change that adds v2 would make every existing consumer's first experience of
/// v2 an outage.
pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    ProtocolDescriptor::new(
        ID,
        crate::protocol::OWNER,
        vec![
            ContractDescriptor::new(ContractVersion::V1, &[v1::WIRE]),
            ContractDescriptor::new(ContractVersion::new(v2::CONTRACT_VERSION)?, &[v2::WIRE]),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_generations_share_one_wire() {
        // The rule this pins is the one that makes a v2 possible at all. Two
        // wires would be two identities, and a dispatch table keyed on the wire
        // alone could not tell the generations apart.
        let descriptor = descriptor().unwrap();
        assert_eq!(v1::WIRE, v2::WIRE);
        assert_eq!(v1::WIRE, ID);

        let versions: Vec<u32> = descriptor
            .contracts
            .iter()
            .map(|c| c.version.get())
            .collect();
        assert_eq!(versions, vec![1, 2]);

        for contract in &descriptor.contracts {
            assert_eq!(
                contract.wire,
                vec![ID.to_string()],
                "a generation travelled on its own wire: {contract:?}"
            );
        }
    }

    #[test]
    fn the_unit_validates_with_two_generations_on_one_wire() {
        // `ProtocolDescriptor::validate` refuses two contracts at one *version*,
        // and used to refuse two versions on one wire. This is the assertion
        // that the second refusal is gone — without it, the descriptor above
        // would compose and then fail at the composition root instead.
        descriptor()
            .unwrap()
            .validate()
            .expect("one unit, two generations, one wire is a legal descriptor");
    }

    #[test]
    fn the_dispatch_key_is_the_unit_and_carries_no_version() {
        // A refused spelling, asserted where someone would be tempted to write
        // it: `claude-code.conversation.v2` would encode the version into the
        // thing that is supposed to carry none, and would be a second name for
        // one identity.
        assert_eq!(COMMAND, ID);
        assert!(!COMMAND.ends_with(".v2"));
    }
}
