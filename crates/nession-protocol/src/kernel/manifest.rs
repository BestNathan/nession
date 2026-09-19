//! The Protocol Set a runtime actually offers.
//!
//! A manifest is **derived from composition**, never written by hand and never
//! inferred from the source tree. That distinction is the whole point: a DTO
//! that exists in a crate but is registered by no runtime is a contract nobody
//! can call, and a manifest built by listing DTOs would advertise it. Building
//! one from the descriptors that were actually composed makes advertising
//! something you cannot serve impossible rather than merely discouraged.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::descriptor::{Lifecycle, ProtocolDescriptor};
use super::identity::{ContractVersion, ProtocolId};

/// Which versions of one contract a provider offers.
///
/// A struct rather than a bare `Vec` so the optional facts the design names —
/// deprecation, experimental, required scope, semantic feature flags — have
/// somewhere to go that is not a breaking change to the map's shape. None of
/// them are populated yet; `第一版应保持最小稳定格式`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ContractSupport {
    pub versions: Vec<ContractVersion>,
}

impl ContractSupport {
    pub fn new(versions: Vec<ContractVersion>) -> Self {
        Self { versions }
    }
}

/// A provider's offered protocol set.
///
/// `protocols` is ordered, so two manifests built from the same descriptors
/// serialise byte-identically. That is not cosmetic: a manifest is the kind of
/// artifact that ends up compared, cached or committed, and a `HashMap` would
/// make unrelated runs differ.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolManifest {
    /// Who offers this set — an agent id, a server, a runtime name.
    pub provider: String,
    pub protocols: BTreeMap<ProtocolId, ContractSupport>,
    /// Diagnostics only.
    ///
    /// The design forbids resolving compatibility from a software version, and
    /// the way to keep that true is for the resolver to be structurally unable
    /// to see this field: it is not passed to it, and there is a test that
    /// resolution is unchanged when it moves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub software_version: Option<String>,
}

impl ProtocolManifest {
    /// Build a manifest from the descriptors a runtime actually composed.
    ///
    /// `Retired` units are omitted: retirement means not served, and a manifest
    /// that still lists one is the "advertises what it cannot do" failure in
    /// its most direct form. The descriptor keeps the identity; the manifest
    /// does not keep the promise.
    pub fn from_descriptors(
        provider: impl Into<String>,
        descriptors: &[ProtocolDescriptor],
    ) -> Self {
        let mut protocols = BTreeMap::new();
        for descriptor in descriptors {
            if descriptor.lifecycle == Lifecycle::Retired {
                continue;
            }
            protocols.insert(
                descriptor.id.clone(),
                ContractSupport::new(descriptor.versions()),
            );
        }
        Self {
            provider: provider.into(),
            protocols,
            software_version: None,
        }
    }

    pub fn with_software_version(mut self, version: impl Into<String>) -> Self {
        self.software_version = Some(version.into());
        self
    }

    /// What this provider offers for `id`, or `None` when it advertises nothing.
    pub fn support(&self, id: &ProtocolId) -> Option<&ContractSupport> {
        self.protocols.get(id)
    }

    pub fn offers(&self, id: &ProtocolId) -> bool {
        self.protocols.contains_key(id)
    }

    pub fn is_empty(&self) -> bool {
        self.protocols.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::descriptor::{ContractDescriptor, ProtocolDescriptor};

    const V1: ContractVersion = ContractVersion::V1;

    fn unit(id: &str, owner: &'static str, versions: &[ContractVersion]) -> ProtocolDescriptor {
        ProtocolDescriptor::new(
            id,
            owner,
            versions
                .iter()
                .map(|v| ContractDescriptor::new(*v, &[]))
                .collect(),
        )
        .unwrap()
    }

    #[test]
    fn lists_exactly_what_was_composed() {
        let manifest = ProtocolManifest::from_descriptors(
            "agent-a",
            &[
                unit("git.status", "nession-git", &[V1]),
                unit("claude-code.read", "nession-claude-code", &[V1]),
            ],
        );

        assert!(manifest.offers(&ProtocolId::new("git.status").unwrap()));
        assert!(manifest.offers(&ProtocolId::new("claude-code.read").unwrap()));
        // The one that was never composed is not advertised — this is the
        // assertion that would fail if a manifest were built by listing DTOs.
        assert!(!manifest.offers(&ProtocolId::new("git.diff").unwrap()));
    }

    #[test]
    fn a_multi_version_unit_advertises_every_version_it_offers() {
        let v2 = ContractVersion::new(2).unwrap();
        let manifest = ProtocolManifest::from_descriptors(
            "server",
            &[unit("session.attach", "nession-protocol", &[V1, v2])],
        );

        let support = manifest
            .support(&ProtocolId::new("session.attach").unwrap())
            .unwrap();
        assert_eq!(support.versions, vec![V1, v2]);
    }

    #[test]
    fn a_retired_unit_is_not_advertised() {
        // Retirement means not served. Keeping the id in the descriptor and
        // dropping it from the manifest is the whole difference.
        let retired =
            unit("session.legacy", "nession-protocol", &[V1]).with_lifecycle(Lifecycle::Retired);
        let manifest = ProtocolManifest::from_descriptors("server", &[retired]);
        assert!(manifest.is_empty());
    }

    #[test]
    fn a_deprecated_unit_is_still_advertised() {
        // Deprecated means "move off it", not "it is gone" — if it stopped
        // being advertised, consumers would break at the moment they were told
        // to migrate.
        let deprecated =
            unit("session.attach", "nession-protocol", &[V1]).with_lifecycle(Lifecycle::Deprecated);
        let manifest = ProtocolManifest::from_descriptors("server", &[deprecated]);
        assert!(manifest.offers(&ProtocolId::new("session.attach").unwrap()));
    }

    #[test]
    fn serialises_in_the_shape_the_design_documents() {
        let manifest = ProtocolManifest::from_descriptors(
            "agent-a",
            &[unit("git.status", "nession-git", &[V1])],
        );
        let json = serde_json::to_value(&manifest).unwrap();
        assert_eq!(json["provider"], "agent-a");
        assert_eq!(json["protocols"]["git.status"]["versions"][0], 1);
        assert!(json.get("software_version").is_none(), "omitted when unset");
    }

    #[test]
    fn two_manifests_from_the_same_descriptors_are_byte_identical() {
        // Ordered map, so an artifact that gets compared or cached does not
        // differ between runs for no reason.
        let build = || {
            ProtocolManifest::from_descriptors(
                "agent-a",
                &[
                    unit("git.status", "nession-git", &[V1]),
                    unit("agent.register", "nession-protocol", &[V1]),
                    unit("claude-code.read", "nession-claude-code", &[V1]),
                ],
            )
        };
        assert_eq!(
            serde_json::to_string(&build()).unwrap(),
            serde_json::to_string(&build()).unwrap()
        );
    }

    #[test]
    fn a_manifest_round_trips_through_serde() {
        // It crosses a wire and gets stored by the server, so both directions
        // matter — including that a bad protocol id is rejected on the way in.
        let manifest = ProtocolManifest::from_descriptors(
            "agent-a",
            &[unit("git.status", "nession-git", &[V1])],
        );
        let text = serde_json::to_string(&manifest).unwrap();
        assert_eq!(
            serde_json::from_str::<ProtocolManifest>(&text).unwrap(),
            manifest
        );

        let bad = r#"{"provider":"a","protocols":{"Not Canonical":{"versions":[1]}}}"#;
        assert!(serde_json::from_str::<ProtocolManifest>(bad).is_err());
    }
}
