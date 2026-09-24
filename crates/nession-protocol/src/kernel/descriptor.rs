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
    ///
    /// Owned rather than `&'static str` because descriptors are built at
    /// runtime — `ProtocolId` is validated, so it cannot be a `const` — and a
    /// `'static` bound here would force providers to leak their wire types to
    /// satisfy a lifetime nothing needs.
    pub wire: Vec<String>,
}

impl ContractDescriptor {
    pub fn new(version: ContractVersion, wire: &[&str]) -> Self {
        Self {
            version,
            wire: wire.iter().map(|w| (*w).to_string()).collect(),
        }
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
    /// **That is the only thing left to check.** Two *versions* sharing one
    /// wire used to be refused here as well, on the reasoning that the
    /// transport could not tell which contract an incoming message was for.
    /// A `contract_version` on the message is what tells it (`#963`), so the
    /// ambiguity is gone — and keeping the refusal would instead make the
    /// model's own `git.status = [v1, v2]` unrepresentable, which is the one
    /// shape the version model exists to express.
    ///
    /// A wire claimed by two *Units* is still a conflict, and it is not
    /// visible from here: a descriptor only ever describes one Unit. That
    /// check needs more than one Unit in hand, so it lives on
    /// [`super::manifest::ProtocolManifest::validate_wires`].
    pub fn validate(&self) -> Result<(), DescriptorError> {
        let mut seen_versions: Vec<ContractVersion> = Vec::new();

        for contract in &self.contracts {
            if seen_versions.contains(&contract.version) {
                return Err(DescriptorError::DuplicateVersion {
                    id: self.id.to_string(),
                    version: contract.version.get(),
                });
            }
            seen_versions.push(contract.version);
        }

        Ok(())
    }

    /// Every version this unit offers.
    pub fn versions(&self) -> Vec<ContractVersion> {
        self.contracts.iter().map(|c| c.version).collect()
    }
}

/// Why a descriptor is not self-consistent.
///
/// One variant, and the second one was removed rather than renamed: a
/// descriptor cannot see a cross-Unit wire conflict, so the `DuplicateWireType`
/// that used to live here was only ever firing on the cross-*version* case
/// `#963` made legal. The conflict it named is real — it just belongs to
/// [`super::manifest::ProtocolManifest::validate_wires`], where more than one
/// Unit is in hand.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DescriptorError {
    #[error("`{id}` declares contract version v{version} more than once")]
    DuplicateVersion { id: String, version: u32 },
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
        // Two versions of one Unit, sharing the Unit's one canonical wire.
        //
        // The wire *is* the id since `#912`, so a v2 that spelled itself
        // `git.status.v2` would be a second Unit wearing the first one's name
        // — and a second identity where the model says there is one. The
        // version selects the generation; the wire locates the Unit.
        let d = descriptor(vec![
            ContractDescriptor::new(V1, &["git.status"]),
            ContractDescriptor::new(ContractVersion::new(2).unwrap(), &["git.status"]),
        ]);
        assert_eq!(
            d.validate(),
            Ok(()),
            "one Unit serving two versions over its one wire is the shape \
             `contract_version` exists to route"
        );
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
    fn one_wire_across_two_versions_is_not_a_conflict() {
        // This was refused until `#963`, on the reasoning that "the transport
        // could not tell which contract an incoming message was for, so the
        // version on the wire would be decided by luck". A `contract_version`
        // on the message is what tells it. The ambiguity the check guarded is
        // gone, and keeping the check would make `git.status = [v1, v2]`
        // unrepresentable — which is the whole point of the version model.
        //
        // The conflict that *remains* is a cross-Unit wire grab, and it cannot
        // be seen from inside one descriptor: a descriptor only ever describes
        // one Unit. `ProtocolManifest::validate_wires` owns that case.
        let d = descriptor(vec![
            ContractDescriptor::new(V1, &["git.status"]),
            ContractDescriptor::new(ContractVersion::new(2).unwrap(), &["git.status"]),
        ]);
        assert!(d.validate().is_ok());
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
