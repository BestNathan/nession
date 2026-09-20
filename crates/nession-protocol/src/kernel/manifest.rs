//! The Protocol Set a runtime actually offers.
//!
//! A manifest is **derived from composition**, never written by hand and never
//! inferred from the source tree. That distinction is the whole point: a DTO
//! that exists in a crate but is registered by no runtime is a contract nobody
//! can call, and a manifest built by listing DTOs would advertise it. Building
//! one from the descriptors that were actually composed makes advertising
//! something you cannot serve impossible rather than merely discouraged.

use std::collections::btree_map::Entry;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::descriptor::{Lifecycle, ProtocolDescriptor};
use super::identity::{ContractVersion, ProtocolId};

/// Which versions of one contract a provider offers, and what carries them.
///
/// A struct rather than a bare `Vec` so the optional facts the design names —
/// deprecation, experimental, required scope, semantic feature flags — have
/// somewhere to go that is not a breaking change to the map's shape. None of
/// them are populated yet; `第一版应保持最小稳定格式`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct ContractSupport {
    pub versions: Vec<ContractVersion>,
    /// The wire message types this contract travels as.
    ///
    /// Carried in the manifest so that a **router which knows no concrete
    /// provider** can still answer "can this peer carry this message?". The
    /// alternative — deriving the protocol id from the wire string — has no
    /// universal rule to derive it with: the registry's own strip-the-namespace
    /// transform yields `claude_code.read` where the id is `claude-code.read`.
    /// The mapping is the provider's to declare, so it is declared here.
    ///
    /// `default` so a manifest from a peer that predates this field still
    /// parses. It then answers "no" to every wire query, which is the safe
    /// direction: the peer is treated as one that has not said.
    #[serde(default)]
    pub wire: Vec<String>,
}

impl ContractSupport {
    pub fn new(versions: Vec<ContractVersion>) -> Self {
        Self {
            versions,
            wire: Vec::new(),
        }
    }

    pub fn with_wire(versions: Vec<ContractVersion>, wire: Vec<String>) -> Self {
        Self { versions, wire }
    }

    pub fn carries(&self, wire_type: &str) -> bool {
        self.wire.iter().any(|w| w == wire_type)
    }
}

/// A provider's offered protocol set.
///
/// `protocols` is ordered, so two manifests built from the same descriptors
/// serialise byte-identically. That is not cosmetic: a manifest is the kind of
/// artifact that ends up compared, cached or committed, and a `HashMap` would
/// make unrelated runs differ.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
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
    ///
    /// **One id may arrive more than once, and the entries are unioned.** A
    /// runtime can offer one unit over several wires — the agent serves
    /// `session.create` for a server and for a browser talking to it directly —
    /// and those are two dispatches with one identity. Replacing instead of
    /// merging would keep whichever came last and silently drop the other's
    /// wires, which is the "advertises less than it serves" failure this type
    /// exists to make impossible.
    ///
    /// `wire` and `versions` are sorted on the way in so that two manifests
    /// built from the same descriptors serialise byte-identically, whatever
    /// order the dispatches were composed in.
    pub fn from_descriptors(
        provider: impl Into<String>,
        descriptors: &[ProtocolDescriptor],
    ) -> Self {
        let mut protocols: BTreeMap<ProtocolId, ContractSupport> = BTreeMap::new();
        for descriptor in descriptors {
            if descriptor.lifecycle == Lifecycle::Retired {
                continue;
            }
            let wire: Vec<String> = descriptor
                .contracts
                .iter()
                .flat_map(|c| c.wire.iter().cloned())
                .collect();

            match protocols.entry(descriptor.id.clone()) {
                Entry::Occupied(mut entry) => {
                    let support = entry.get_mut();
                    support.wire.extend(wire);
                    support.wire.sort();
                    support.wire.dedup();
                    support.versions.extend(descriptor.versions());
                    support.versions.sort();
                    support.versions.dedup();
                }
                Entry::Vacant(entry) => {
                    let mut versions = descriptor.versions();
                    let mut wire = wire;
                    versions.sort();
                    wire.sort();
                    wire.dedup();
                    entry.insert(ContractSupport::with_wire(versions, wire));
                }
            }
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

    /// Which Protocol Unit carries `wire_type`, if this provider carries it.
    ///
    /// What a router asks: the Server relays `extension.git.status` to an agent
    /// it must not know the internals of, and this is how it answers "does that
    /// peer say it can carry this?" without a mapping of its own.
    ///
    /// A linear scan, deliberately. A manifest is a handful of units, and the
    /// alternative — an index kept in step with `protocols` — is a second
    /// structure that can disagree with the first, which is the class of bug
    /// this whole issue exists to remove. If a manifest ever grows past the
    /// point where this shows up in a profile, the index can be built then,
    /// with a measurement to justify it.
    pub fn unit_for_wire(&self, wire_type: &str) -> Option<&ProtocolId> {
        self.protocols
            .iter()
            .find(|(_, support)| support.carries(wire_type))
            .map(|(id, _)| id)
    }

    /// Whether this provider declares it can carry `wire_type`.
    pub fn carries(&self, wire_type: &str) -> bool {
        self.unit_for_wire(wire_type).is_some()
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
    fn one_unit_over_two_wires_arrives_as_two_descriptors_and_keeps_both() {
        // The shape a real runtime has: the agent serves `session.create` for a
        // server and for a browser talking to it directly, and those are two
        // dispatches with one identity. This used to `insert` — keep the last,
        // drop the other's wire — which is the manifest advertising *less* than
        // the runtime serves, and a router gating the dropped wire would refuse
        // a call the agent would have answered.
        let manifest = ProtocolManifest::from_descriptors(
            "agent-a",
            &[
                ProtocolDescriptor::new(
                    "session.create",
                    "nession-agent",
                    vec![ContractDescriptor::new(V1, &["server.session.create"])],
                )
                .unwrap(),
                ProtocolDescriptor::new(
                    "session.create",
                    "nession-agent",
                    vec![ContractDescriptor::new(V1, &["session.create"])],
                )
                .unwrap(),
            ],
        );

        assert!(manifest.carries("server.session.create"));
        assert!(
            manifest.carries("session.create"),
            "the second descriptor's wire must survive the first"
        );
        // One unit, not two — the union is by id, and the map is keyed by it.
        assert_eq!(manifest.protocols.len(), 1);
        assert_eq!(
            manifest.protocols[&ProtocolId::new("session.create").unwrap()]
                .wire
                .len(),
            2
        );
    }

    #[test]
    fn a_unit_offered_at_two_versions_keeps_both() {
        // Same union, on the other axis. A provider that gained a second version
        // declares it in its own descriptor, and a manifest that kept only the
        // last would make the resolver unable to select the older one — which
        // is the "highest common version" rule losing the version it was
        // supposed to compare against.
        let manifest = ProtocolManifest::from_descriptors(
            "agent-a",
            &[
                ProtocolDescriptor::new(
                    "git.status",
                    "nession-git",
                    vec![ContractDescriptor::new(V1, &["extension.git.status"])],
                )
                .unwrap(),
                ProtocolDescriptor::new(
                    "git.status",
                    "nession-git",
                    vec![ContractDescriptor::new(
                        ContractVersion::new(2).unwrap(),
                        &["extension.git.status.v2"],
                    )],
                )
                .unwrap(),
            ],
        );

        let support = &manifest.protocols[&ProtocolId::new("git.status").unwrap()];
        assert_eq!(support.versions, vec![V1, ContractVersion::new(2).unwrap()]);
        assert_eq!(support.wire.len(), 2);
    }

    #[test]
    fn a_wire_type_resolves_to_the_unit_that_carries_it() {
        // What a router asks. The Server relays `extension.git.status` to an
        // agent whose internals it must not know; this is how it checks.
        let manifest = ProtocolManifest::from_descriptors(
            "agent-a",
            &[ProtocolDescriptor::new(
                "git.status",
                "nession-git",
                vec![ContractDescriptor::new(V1, &["extension.git.status"])],
            )
            .unwrap()],
        );

        assert_eq!(
            manifest
                .unit_for_wire("extension.git.status")
                .map(ProtocolId::as_str),
            Some("git.status")
        );
        assert!(manifest.carries("extension.git.status"));
        assert!(!manifest.carries("extension.git.diff"));
        assert!(manifest.unit_for_wire("extension.git.diff").is_none());
    }

    #[test]
    fn a_manifest_without_wire_projections_answers_no_rather_than_guessing() {
        // A peer that predates the field sends versions only. It must not be
        // read as carrying everything — "has not said" and "said yes" are
        // different, and the safe direction is the one that does not relay.
        let manifest: ProtocolManifest = serde_json::from_value(serde_json::json!({
            "provider": "old-agent",
            "protocols": { "git.status": { "versions": [1] } }
        }))
        .unwrap();

        assert!(manifest.offers(&ProtocolId::new("git.status").unwrap()));
        assert!(!manifest.carries("extension.git.status"));
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
