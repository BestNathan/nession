//! What a Protocol Unit declares about itself.
//!
//! A descriptor is the unit's identity plus the contracts it currently offers,
//! and it is **code**, not data: it is what a provider writes next to its
//! implementation. The wire-facing projection of the same facts is the
//! [`super::manifest`], which is derived and therefore cannot disagree with
//! what is actually registered.
//!
//! Keeping the two apart is the design's "runtime manifest comes from actually
//! composed providers, not from DTOs existing in the source": a descriptor can
//! exist for a contract no runtime composes, and the manifest will correctly
//! not mention it.

use super::identity::{ContractVersion, IdentityError, ProtocolId};

/// Where a Protocol Unit sits in its own life.
///
/// The minimal representation the design asks for, and deliberately without
/// dates or replacement pointers: those are the parts that need a real second
/// user before they can be designed, and guessing them now would make every
/// retired contract carry fields nobody reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lifecycle {
    /// Offered, supported, expected to be used.
    #[default]
    Active,
    /// Still served, but consumers are expected to move off it.
    Deprecated,
    /// Not served. Kept in the descriptor so the identity cannot be silently
    /// reused for something else — a retired id that disappears is an id that
    /// comes back meaning a different protocol.
    Retired,
}

/// One version of one Protocol Unit's contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractDescriptor {
    pub version: ContractVersion,
    /// The wire message types this contract version travels as.
    ///
    /// Empty is a real and temporary state — a contract defined in code that no
    /// transport carries yet — and it is stated rather than inferred, because
    /// "no wire types" and "wire types nobody remembered to declare" are the
    /// same emptiness with different consequences.
    pub wire: &'static [&'static str],
}

impl ContractDescriptor {
    pub const fn new(version: ContractVersion, wire: &'static [&'static str]) -> Self {
        Self { version, wire }
    }
}

/// A Protocol Unit as its owner declares it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolDescriptor {
    pub id: ProtocolId,
    /// The crate that owns this contract. Also the answer to "who do I ask when
    /// this changes?" — which is the question a central DTO repository could
    /// never answer for extension contracts.
    pub owner: &'static str,
    pub contracts: Vec<ContractDescriptor>,
    pub lifecycle: Lifecycle,
}

impl ProtocolDescriptor {
    /// A live unit offering one contract.
    pub fn new(
        id: &str,
        owner: &'static str,
        contracts: Vec<ContractDescriptor>,
    ) -> Result<Self, IdentityError> {
        Ok(Self {
            id: ProtocolId::new(id)?,
            owner,
            contracts,
            lifecycle: Lifecycle::Active,
        })
    }

    pub fn with_lifecycle(mut self, lifecycle: Lifecycle) -> Self {
        self.lifecycle = lifecycle;
        self
    }

    /// Check the descriptor against itself.
    ///
    /// Two contracts claiming one version is the shape that makes resolution
    /// ambiguous — the resolver would pick one by iteration order, which is the
    /// kind of answer that changes when a `Vec` becomes a `HashMap`.
    ///
    /// One wire message type claimed by two contract versions is the other
    /// half: the transport could no longer tell which contract an incoming
    /// message was for, so the version on the wire would be decided by luck.
    pub fn validate(&self) -> Result<(), DescriptorError> {
        let mut seen_versions: Vec<ContractVersion> = Vec::new();
        let mut seen_wire: Vec<&'static str> = Vec::new();

        for contract in &self.contracts {
            if seen_versions.contains(&contract.version) {
                return Err(DescriptorError::DuplicateVersion {
                    id: self.id.to_string(),
                    version: contract.version.get(),
                });
            }
            seen_versions.push(contract.version);

            for wire in contract.wire {
                if seen_wire.contains(wire) {
                    return Err(DescriptorError::DuplicateWireType {
                        id: self.id.to_string(),
                        wire: (*wire).to_string(),
                    });
                }
                seen_wire.push(wire);
            }
        }

        Ok(())
    }

    /// Every version this unit offers.
    pub fn versions(&self) -> Vec<ContractVersion> {
        self.contracts.iter().map(|c| c.version).collect()
    }
}

/// Why a descriptor is not self-consistent.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DescriptorError {
    #[error("`{id}` declares contract version v{version} more than once")]
    DuplicateVersion { id: String, version: u32 },
    #[error("`{id}` maps wire message type `{wire}` to more than one contract version")]
    DuplicateWireType { id: String, wire: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    const V1: ContractVersion = ContractVersion::V1;

    fn descriptor(contracts: Vec<ContractDescriptor>) -> ProtocolDescriptor {
        ProtocolDescriptor::new("git.status", "nession-git", contracts).unwrap()
    }

    #[test]
    fn accepts_one_contract_per_version() {
        let d = descriptor(vec![
            ContractDescriptor::new(V1, &["extension.git.status"]),
            ContractDescriptor::new(
                ContractVersion::new(2).unwrap(),
                &["extension.git.status.v2"],
            ),
        ]);
        assert!(d.validate().is_ok());
        assert_eq!(d.versions().len(), 2);
    }

    #[test]
    fn refuses_two_contracts_at_the_same_version() {
        let d = descriptor(vec![
            ContractDescriptor::new(V1, &["a"]),
            ContractDescriptor::new(V1, &["b"]),
        ]);
        assert_eq!(
            d.validate().unwrap_err(),
            DescriptorError::DuplicateVersion {
                id: "git.status".to_string(),
                version: 1
            }
        );
    }

    #[test]
    fn refuses_one_wire_type_serving_two_versions() {
        // Otherwise the transport cannot tell which contract arrived, and the
        // version is decided by whichever the resolver happened to look at.
        let d = descriptor(vec![
            ContractDescriptor::new(V1, &["extension.git.status"]),
            ContractDescriptor::new(ContractVersion::new(2).unwrap(), &["extension.git.status"]),
        ]);
        assert!(matches!(
            d.validate().unwrap_err(),
            DescriptorError::DuplicateWireType { .. }
        ));
    }

    #[test]
    fn a_contract_with_no_wire_types_is_allowed() {
        // Defined in code, carried by no transport yet — a real state during
        // migration, and stated rather than inferred.
        let d = descriptor(vec![ContractDescriptor::new(V1, &[])]);
        assert!(d.validate().is_ok());
    }

    #[test]
    fn a_retired_unit_keeps_its_identity() {
        // A retired id that vanishes is an id that comes back meaning
        // something else.
        let d =
            descriptor(vec![ContractDescriptor::new(V1, &[])]).with_lifecycle(Lifecycle::Retired);
        assert_eq!(d.lifecycle, Lifecycle::Retired);
        assert_eq!(d.id.as_str(), "git.status");
    }

    #[test]
    fn refuses_a_non_canonical_id_at_construction() {
        assert!(ProtocolDescriptor::new("Git.Status", "x", vec![]).is_err());
    }
}
