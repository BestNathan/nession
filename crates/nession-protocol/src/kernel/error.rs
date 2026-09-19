//! What resolution can refuse, and what each refusal means to a caller.
//!
//! Deliberately *only* what this crate can produce today. The design's routing
//! errors — permission denied, target offline, stale manifest, malformed
//! payload — belong to the pipeline that decides them (Phase 3), and declaring
//! them here first would give every one of them a variant no code can
//! construct and no test can reach.

use super::identity::{ContractVersion, ProtocolId};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    /// The provider's manifest does not mention this Protocol Unit at all.
    #[error("`{id}` is not advertised by `{provider}`")]
    NotAdvertised { id: ProtocolId, provider: String },

    /// The provider offers the unit, but at no version this consumer speaks.
    ///
    /// Carries both sides because that is the whole value of the error: a
    /// reader can see immediately which end has to move, and a UI can say
    /// "this agent offers v1, you need v2" instead of "unsupported".
    #[error(
        "`{id}`: `{provider}` offers {provider_versions:?} and this consumer speaks {consumer:?}"
    )]
    ContractNotSupported {
        id: ProtocolId,
        provider: String,
        consumer: Vec<ContractVersion>,
        provider_versions: Vec<ContractVersion>,
    },
}

impl ProtocolError {
    /// Whether this failure should disable one Protocol Unit or the whole
    /// exchange.
    ///
    /// Always the former, today, and stated as a method rather than left to
    /// each caller: the design's rule is that a unit with no common version
    /// does not take the connection down with it, and a caller deciding that
    /// individually is how one of them eventually decides otherwise.
    pub fn is_unit_scoped(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> ProtocolId {
        ProtocolId::new("git.status").unwrap()
    }

    #[test]
    fn the_unsupported_message_names_both_sides() {
        // The point of the variant: a reader learns who has to move. A message
        // that only said "unsupported" would send them to the wrong crate.
        let err = ProtocolError::ContractNotSupported {
            id: id(),
            provider: "agent-a".to_string(),
            consumer: vec![ContractVersion::new(2).unwrap()],
            provider_versions: vec![ContractVersion::V1],
        };
        let text = err.to_string();
        assert!(text.contains("agent-a"), "got {text}");
        assert!(text.contains("git.status"), "got {text}");
        assert!(text.contains("v2") && text.contains("v1"), "got {text}");
    }

    #[test]
    fn every_refusal_so_far_is_unit_scoped() {
        let not_advertised = ProtocolError::NotAdvertised {
            id: id(),
            provider: "agent-a".to_string(),
        };
        assert!(not_advertised.is_unit_scoped());
        assert!(ProtocolError::ContractNotSupported {
            id: id(),
            provider: "agent-a".to_string(),
            consumer: vec![],
            provider_versions: vec![],
        }
        .is_unit_scoped());
    }
}
