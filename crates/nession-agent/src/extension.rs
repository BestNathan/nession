//! Runtime extension composition (#678).
//!
//! The registry is a **composition boundary**, not a lookup table that happens
//! to be filled in at startup. Everything it routes is derived from what the
//! providers declared, and anything the declarations disagree about fails the
//! build here — at startup, naming both sides — rather than resolving by
//! whatever order the extensions happened to be listed in.
//!
//! ## What used to happen
//!
//! `handlers.insert(msg_type, …)` discarded its return value, so two
//! extensions claiming one message type silently produced a registry where the
//! **last one registered** won. No log, no error, no test — and the failure was
//! partial, because the loser's *other* message types still registered, so
//! nothing ever looked broken enough to investigate.
//!
//! ## Why the routes are derived rather than checked
//!
//! The design lists "provider advertises no handler" and "handler exists but not
//! advertised" as startup failures. Both are failures only while the advertised
//! set and the routed set are two lists. Deriving the routes from the
//! descriptors makes them one list, so neither state is constructible — which is
//! a stronger guarantee than detecting either after the fact.

use std::collections::{BTreeMap, HashMap};

use nession_common::extension::AgentExtension;
use nession_protocol::{
    ContractVersion, DescriptorError, IdentityError, ProtocolDescriptor, ProtocolId,
    ProtocolManifest,
};
use serde_json::Value;
use tracing::debug;

/// Where one wire message type goes.
#[derive(Debug, Clone)]
struct Route {
    extension: usize,
    /// What `handle_command` receives: the wire type without its namespace.
    command: String,
    /// The Protocol Unit and contract version this route serves, so a dispatch
    /// can say what it answered rather than only that it answered.
    id: ProtocolId,
    version: ContractVersion,
}

/// Dispatches server-relayed commands to registered extensions, and describes
/// what this runtime offers.
///
/// Built once at startup; shared immutably across all connections.
pub struct ExtensionRegistry {
    routes: HashMap<String, Route>,
    manifest: ProtocolManifest,
    extensions: Vec<Box<dyn AgentExtension>>,
}

/// What this registry composed, for diagnostics.
///
/// Hand-written rather than derived: the extensions are trait objects with no
/// `Debug`, and their names are already in the manifest's provenance. Printing
/// the manifest is the useful half — it is the thing an agent would log at
/// startup to answer "what am I actually offering?".
impl std::fmt::Debug for ExtensionRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExtensionRegistry")
            .field("routes", &self.routes.len())
            .field("manifest", &self.manifest)
            .finish()
    }
}

/// Why a set of extensions cannot be composed.
///
/// Every variant names **both** sides of a conflict. "Duplicate wire type" is
/// not actionable; "`extension.x` claimed by both `git` and `claude_code`" is,
/// and it is the difference between a five-minute fix and a bisect.
#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("`{owner}` cannot name its own contracts: {source}")]
    InvalidDeclaration {
        owner: &'static str,
        #[source]
        source: IdentityError,
    },

    #[error("`{owner}` declares a descriptor that is not self-consistent: {source}")]
    InconsistentDescriptor {
        owner: &'static str,
        #[source]
        source: DescriptorError,
    },

    #[error("`{owner}` declares no contracts — an extension that serves nothing is a composition mistake")]
    DeclaresNothing { owner: &'static str },

    #[error("wire message type `{wire}` is claimed by both `{first}` and `{second}`")]
    DuplicateWireType {
        wire: String,
        first: &'static str,
        second: &'static str,
    },

    #[error("protocol `{id}` is claimed by both `{first}` and `{second}`")]
    DuplicateProtocol {
        id: String,
        first: &'static str,
        second: &'static str,
    },
}

impl ExtensionRegistry {
    /// Compose a set of extensions, or say why they cannot be composed.
    ///
    /// `provider` names the runtime for the manifest — an agent id, or whatever
    /// identifies this process to a consumer resolving against it.
    pub fn new(
        provider: impl Into<String>,
        extensions: Vec<Box<dyn AgentExtension>>,
    ) -> Result<Self, RegistryError> {
        let mut routes: HashMap<String, Route> = HashMap::new();
        let mut declared: Vec<ProtocolDescriptor> = Vec::new();
        // Which extension owns each Protocol Unit, for the duplicate check.
        let mut owner_of: BTreeMap<String, &'static str> = BTreeMap::new();

        for (extension, unit) in extensions.iter().enumerate() {
            let owner = unit.name();

            let descriptors = unit
                .descriptors()
                .map_err(|source| RegistryError::InvalidDeclaration { owner, source })?;

            if descriptors.is_empty() {
                return Err(RegistryError::DeclaresNothing { owner });
            }

            for descriptor in descriptors {
                descriptor
                    .validate()
                    .map_err(|source| RegistryError::InconsistentDescriptor { owner, source })?;

                let id = descriptor.id.as_str().to_string();
                if let Some(first) = owner_of.get(&id) {
                    return Err(RegistryError::DuplicateProtocol {
                        id,
                        first,
                        second: owner,
                    });
                }
                owner_of.insert(id, owner);

                for contract in &descriptor.contracts {
                    for wire in &contract.wire {
                        // The namespace is the transport's, not the protocol's:
                        // `handle_command` receives what follows it. Derived
                        // here, once, so no provider re-spells it.
                        let command = wire.strip_prefix("extension.").unwrap_or(wire);

                        if let Some(existing) = routes.get(wire) {
                            let first = extensions
                                .get(existing.extension)
                                .map_or("unknown", |e| e.name());
                            return Err(RegistryError::DuplicateWireType {
                                wire: wire.clone(),
                                first,
                                second: owner,
                            });
                        }

                        routes.insert(
                            wire.clone(),
                            Route {
                                extension,
                                command: command.to_string(),
                                id: descriptor.id.clone(),
                                version: contract.version,
                            },
                        );
                    }
                }

                declared.push(descriptor);
            }
        }

        Ok(Self {
            routes,
            // Derived from what was actually composed. A contract that exists in
            // a crate but is declared by no extension is absent here, which is
            // the whole point of deriving rather than listing.
            manifest: ProtocolManifest::from_descriptors(provider, &declared),
            extensions,
        })
    }

    /// What this runtime offers — the manifest a peer resolves against.
    pub fn manifest(&self) -> &ProtocolManifest {
        &self.manifest
    }

    /// Try to dispatch a message. Returns `Some(response)` if handled, `None` to
    /// fall through to built-in handlers.
    pub async fn dispatch(&self, msg_type: &str, payload: Value) -> Option<anyhow::Result<Value>> {
        let route = self.routes.get(msg_type)?;
        let ext = self.extensions.get(route.extension)?;
        debug!(
            "Extension dispatch: {} → {} (msg_type: {}, protocol: {}@{})",
            ext.name(),
            route.command,
            msg_type,
            route.id,
            route.version
        );
        Some(ext.handle_command(&route.command, payload).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use nession_protocol::{ContractDescriptor, ProtocolDescriptor};

    /// One extension's declaration, describable without a real provider.
    struct Fake {
        name: &'static str,
        descriptor_id: &'static str,
        wire: &'static str,
    }

    impl Fake {
        fn new(name: &'static str, descriptor_id: &'static str, wire: &'static str) -> Self {
            Self {
                name,
                descriptor_id,
                wire,
            }
        }
    }

    #[async_trait]
    impl AgentExtension for Fake {
        fn name(&self) -> &'static str {
            self.name
        }

        fn descriptors(&self) -> Result<Vec<ProtocolDescriptor>, IdentityError> {
            Ok(vec![ProtocolDescriptor::new(
                self.descriptor_id,
                "test",
                vec![ContractDescriptor::new(ContractVersion::V1, &[self.wire])],
            )?])
        }

        async fn handle_command(&self, _command: &str, _payload: Value) -> anyhow::Result<Value> {
            Ok(Value::Null)
        }
    }

    /// An extension that declares nothing at all.
    struct Silent;

    #[async_trait]
    impl AgentExtension for Silent {
        fn name(&self) -> &'static str {
            "silent"
        }

        fn descriptors(&self) -> Result<Vec<ProtocolDescriptor>, IdentityError> {
            Ok(Vec::new())
        }

        async fn handle_command(&self, _command: &str, _payload: Value) -> anyhow::Result<Value> {
            Ok(Value::Null)
        }
    }

    fn compose(
        extensions: Vec<Box<dyn AgentExtension>>,
    ) -> Result<ExtensionRegistry, RegistryError> {
        ExtensionRegistry::new("agent-a", extensions)
    }

    #[test]
    fn a_well_formed_pair_composes_and_derives_a_manifest() {
        let registry = compose(vec![
            Box::new(Fake::new("git", "git.status", "extension.git.status")),
            Box::new(Fake::new(
                "claude_code",
                "claude-code.read",
                "extension.claude_code.read",
            )),
        ])
        .unwrap();

        let manifest = registry.manifest();
        assert_eq!(manifest.provider, "agent-a");
        assert!(manifest.offers(&ProtocolId::new("git.status").unwrap()));
        assert!(manifest.offers(&ProtocolId::new("claude-code.read").unwrap()));
        // Nothing composed, nothing advertised — the point of deriving rather
        // than listing.
        assert!(!manifest.offers(&ProtocolId::new("git.diff").unwrap()));
    }

    #[test]
    fn two_providers_claiming_one_wire_type_fail_and_both_are_named() {
        // The regression this whole change exists for: this used to be a silent
        // `handlers.insert`, where the second registration won and the first
        // provider's route vanished without a log line.
        let err = compose(vec![
            Box::new(Fake::new("git", "git.status", "extension.shared.thing")),
            Box::new(Fake::new(
                "claude_code",
                "claude-code.read",
                "extension.shared.thing",
            )),
        ])
        .unwrap_err();

        assert!(
            matches!(err, RegistryError::DuplicateWireType { .. }),
            "got {err:?}"
        );
        let text = err.to_string();
        assert!(text.contains("git"), "must name the first claimant: {text}");
        assert!(
            text.contains("claude_code"),
            "must name the second claimant: {text}"
        );
        assert!(
            text.contains("extension.shared.thing"),
            "must name the wire type: {text}"
        );
    }

    #[test]
    fn two_providers_claiming_one_protocol_fail() {
        let err = compose(vec![
            Box::new(Fake::new("git", "shared.thing", "extension.git.thing")),
            Box::new(Fake::new(
                "claude_code",
                "shared.thing",
                "extension.claude_code.thing",
            )),
        ])
        .unwrap_err();

        assert!(
            matches!(err, RegistryError::DuplicateProtocol { .. }),
            "got {err:?}"
        );
        assert!(err.to_string().contains("shared.thing"));
    }

    #[test]
    fn an_extension_that_declares_nothing_is_a_composition_mistake() {
        // Not a harmless no-op: it means a provider was registered and will
        // never be reachable, and the manifest will not mention it.
        let err = compose(vec![Box::new(Silent)]).unwrap_err();
        assert!(
            matches!(err, RegistryError::DeclaresNothing { .. }),
            "got {err:?}"
        );
        assert!(err.to_string().contains("silent"));
    }

    #[test]
    fn a_non_canonical_protocol_id_fails_composition_rather_than_panicking() {
        // `ProtocolDescriptor::new` validates; this is where the process finds
        // out, with the owning extension named.
        let err = compose(vec![Box::new(Fake::new(
            "git",
            "Not Canonical",
            "extension.git.thing",
        ))])
        .unwrap_err();
        assert!(
            matches!(err, RegistryError::InvalidDeclaration { .. }),
            "got {err:?}"
        );
        assert!(err.to_string().contains("git"));
    }

    #[tokio::test]
    async fn dispatch_derives_the_command_suffix_from_the_wire_type() {
        // The namespace strip happens once, here — no provider re-spells it, and
        // `claude_code.read` (the suffix) is not `claude-code.read` (the id).
        let registry = compose(vec![Box::new(Fake::new(
            "claude_code",
            "claude-code.read",
            "extension.claude_code.read",
        ))])
        .unwrap();

        assert!(
            registry
                .dispatch("extension.claude_code.read", Value::Null)
                .await
                .is_some(),
            "a declared wire type must dispatch"
        );
        assert!(
            registry
                .dispatch("extension.git.status", Value::Null)
                .await
                .is_none(),
            "an undeclared wire type must fall through, not be swallowed"
        );
    }
}
