//! Consumer Requirements ∩ Provider Manifest → the contract version to use.
//!
//! Three rules the design fixes, each of which is a way this could otherwise go
//! wrong quietly:
//!
//! 1. **Highest common version**, not the provider's newest. A consumer that
//!    speaks v1 and v2 talking to a provider offering v1 and v3 must land on
//!    v1; picking v3 because it is the newest would send a payload the consumer
//!    cannot read.
//! 2. **Versions are not assumed contiguous.** `[1, 3]` is a legitimate answer
//!    set, so the intersection is computed over what is actually declared
//!    rather than by walking down from a maximum.
//! 3. **No intersection disables one unit, not the connection.** The unit's
//!    incompatibility is returned as a value the caller can render, not as a
//!    failure that unwinds the session — an Agent that cannot do `git.diff` is
//!    still an Agent.
//!
//! ## What is deliberately not consulted
//!
//! `software_version`. The design forbids guessing protocol compatibility from
//! a release number, and the cheapest way to keep that true is that no function
//! here has a version to guess from: [`ProtocolManifest`] is the only input,
//! and a test pins that changing the software version changes no answer.

use super::error::ProtocolError;
use super::identity::{ContractVersion, ProtocolId};
use super::manifest::ProtocolManifest;

/// The highest version both sides offer.
///
/// `None` when they share none — including when either list is empty, which is
/// the same answer for the same reason: nothing can be chosen from nothing.
pub fn select_version(
    consumer: &[ContractVersion],
    provider: &[ContractVersion],
) -> Option<ContractVersion> {
    provider
        .iter()
        .filter(|candidate| consumer.contains(candidate))
        .max()
        .copied()
}

/// Resolve one Protocol Unit against one provider's manifest.
///
/// The two failure cases are kept apart because they are different sentences to
/// a reader: a provider that never claimed the protocol at all, and a provider
/// that claims it but at versions this consumer does not speak. Collapsing them
/// would report "unsupported" for both and hide which side has to move.
pub fn resolve(
    id: &ProtocolId,
    consumer: &[ContractVersion],
    manifest: &ProtocolManifest,
) -> Result<ContractVersion, ProtocolError> {
    let Some(support) = manifest.support(id) else {
        return Err(ProtocolError::NotAdvertised {
            id: id.clone(),
            provider: manifest.provider.clone(),
        });
    };

    select_version(consumer, &support.versions).ok_or_else(|| ProtocolError::ContractNotSupported {
        id: id.clone(),
        provider: manifest.provider.clone(),
        consumer: consumer.to_vec(),
        provider_versions: support.versions.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::descriptor::{ContractDescriptor, ProtocolDescriptor};

    fn v(n: u32) -> ContractVersion {
        ContractVersion::new(n).unwrap()
    }

    fn manifest(versions: &[ContractVersion]) -> ProtocolManifest {
        ProtocolManifest::from_descriptors(
            "agent-a",
            &[ProtocolDescriptor::new(
                "git.status",
                "nession-git",
                versions
                    .iter()
                    .map(|x| ContractDescriptor::new(*x, &[]))
                    .collect(),
            )
            .unwrap()],
        )
    }

    fn git_status() -> ProtocolId {
        ProtocolId::new("git.status").unwrap()
    }

    #[test]
    fn picks_the_highest_shared_version() {
        assert_eq!(select_version(&[v(1), v(2)], &[v(1)]), Some(v(1)));
        assert_eq!(select_version(&[v(1), v(2)], &[v(1), v(2)]), Some(v(2)));
        assert_eq!(select_version(&[v(1), v(2), v(3)], &[v(3)]), Some(v(3)));
    }

    #[test]
    fn does_not_assume_versions_are_contiguous() {
        // `[1, 3]` is a real answer set — a version can be retired while its
        // neighbours live. Walking down from a maximum finds 2 and stops.
        assert_eq!(select_version(&[v(1), v(3)], &[v(1), v(3)]), Some(v(3)));
        assert_eq!(select_version(&[v(1), v(3)], &[v(2)]), None);
    }

    #[test]
    fn resolves_to_a_version_both_sides_offer() {
        let resolved = resolve(&git_status(), &[v(1), v(2)], &manifest(&[v(1)])).unwrap();
        assert_eq!(resolved, v(1));
    }

    #[test]
    fn a_provider_that_never_claimed_the_unit_is_a_different_answer() {
        let empty = ProtocolManifest::from_descriptors("agent-a", &[]);
        let err = resolve(&git_status(), &[v(1)], &empty).unwrap_err();
        assert!(
            matches!(err, ProtocolError::NotAdvertised { .. }),
            "got {err:?}"
        );
    }

    #[test]
    fn no_shared_version_names_both_sides_so_the_reader_knows_who_moves() {
        let err = resolve(&git_status(), &[v(2)], &manifest(&[v(1)])).unwrap_err();
        match err {
            ProtocolError::ContractNotSupported {
                consumer,
                provider_versions,
                ..
            } => {
                assert_eq!(consumer, vec![v(2)]);
                assert_eq!(provider_versions, vec![v(1)]);
            }
            other => panic!("expected ContractNotSupported, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_consumer_requirement_resolves_to_nothing() {
        // A consumer that speaks no versions of a unit it is asking for is the
        // same answer as one that shares none — nothing can be chosen from
        // nothing, and reporting it as a success would be the worse failure.
        let err = resolve(&git_status(), &[], &manifest(&[v(1)])).unwrap_err();
        assert!(matches!(err, ProtocolError::ContractNotSupported { .. }));
    }

    #[test]
    fn the_software_version_changes_no_answer() {
        // The design forbids resolving compatibility from a release number.
        // Pinning it here means a future change that consults it fails a test
        // rather than shipping.
        let plain = manifest(&[v(1)]);
        let labelled = manifest(&[v(1)]).with_software_version("0.42.0");
        assert_eq!(
            resolve(&git_status(), &[v(1), v(2)], &plain).unwrap(),
            resolve(&git_status(), &[v(1), v(2)], &labelled).unwrap()
        );
    }

    #[test]
    fn resolution_is_per_unit_so_one_gap_does_not_affect_another() {
        // The failure mode this rules out is a single connection-level
        // negotiation that disables everything when one unit does not line up.
        let manifest = ProtocolManifest::from_descriptors(
            "agent-a",
            &[
                ProtocolDescriptor::new(
                    "git.status",
                    "nession-git",
                    vec![ContractDescriptor::new(v(1), &[])],
                )
                .unwrap(),
                ProtocolDescriptor::new(
                    "git.diff",
                    "nession-git",
                    vec![ContractDescriptor::new(v(2), &[])],
                )
                .unwrap(),
            ],
        );

        assert!(resolve(&git_status(), &[v(1)], &manifest).is_ok());
        assert!(resolve(&ProtocolId::new("git.diff").unwrap(), &[v(1)], &manifest).is_err());
    }
}
