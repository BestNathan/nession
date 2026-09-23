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
/// not actionable; "`repo.info` claimed by both `git` and `claude_code`" is,
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

    #[error("`{wire}` is claimed by both `{first}` and `{second}`")]
    DuplicateCoreWireType {
        wire: String,
        first: String,
        second: String,
    },
}

impl ExtensionRegistry {
    /// Compose a set of extensions, or say why they cannot be composed.
    ///
    /// `provider` names the runtime for the manifest — an agent id, or whatever
    /// identifies this process to a consumer resolving against it.
    ///
    /// `core` is the other half of what this runtime serves: the Protocol Units
    /// whose handlers are the agent's own methods rather than an
    /// [`AgentExtension`] (`#678`, Phase 6). They are **named here and routed
    /// elsewhere** — [`crate::connection::server_client`] dispatches them from
    /// the same declaration that produces this list — so the registry's job is
    /// only to put them in the manifest and to refuse a collision with an
    /// extension. A wire type claimed by both halves would route to one of them
    /// and silently never reach the other, which is the failure the derivations
    /// on each side exist to prevent between themselves.
    pub fn new(
        provider: impl Into<String>,
        extensions: Vec<Box<dyn AgentExtension>>,
        core: Vec<ProtocolDescriptor>,
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
                                id: descriptor.id.clone(),
                                version: contract.version,
                            },
                        );
                    }
                }

                declared.push(descriptor);
            }
        }

        // The core half, after the extension half so a collision can name which
        // side claimed the wire type first.
        //
        // `core` is the union of this agent's own dispatchers — one list per
        // transport, both answering for this one provider — so the same unit
        // legitimately arrives twice with the wire types each path uses. A wire
        // claimed by two *units* is still a failure: the generated `match` would
        // take the first arm and leave the second unreachable, which is the
        // state the two derivations exist to make unconstructible. A wire
        // claimed twice by the *same* unit is that unit being served on two
        // transports, and both arms dispatch it.
        let mut core_wires: BTreeMap<String, String> = BTreeMap::new();

        for descriptor in core {
            descriptor
                .validate()
                .map_err(|source| RegistryError::InconsistentDescriptor {
                    owner: crate::protocol::OWNER,
                    source,
                })?;

            let unit = descriptor.id.as_str().to_string();

            for contract in &descriptor.contracts {
                for wire in &contract.wire {
                    if let Some(existing) = routes.get(wire) {
                        let first = extensions
                            .get(existing.extension)
                            .map_or("unknown", |e| e.name())
                            .to_string();
                        return Err(RegistryError::DuplicateCoreWireType {
                            wire: wire.clone(),
                            first,
                            second: unit,
                        });
                    }

                    // Core against core. A repeat of the *same* unit is not a
                    // collision: `session.capture_preview` is answered for the
                    // central server and for a browser connecting directly, and
                    // that is one contract on two transports — the framing
                    // around it is the transport's, and the two payloads differ
                    // only by the server's `request_id` correlation.
                    if let Some(first) = core_wires.insert(wire.clone(), unit.clone()) {
                        if first != unit {
                            return Err(RegistryError::DuplicateCoreWireType {
                                wire: wire.clone(),
                                first,
                                second: unit,
                            });
                        }
                    }
                }
            }

            declared.push(descriptor);
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
            "Extension dispatch: {} → {} (protocol: {}@{})",
            ext.name(),
            msg_type,
            route.id,
            route.version
        );
        // `msg_type` and not a stripped copy of it: the wire *is* the protocol
        // id now, so the extension is handed exactly the name it declared.
        Some(ext.handle_command(msg_type, payload).await)
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
        ExtensionRegistry::new("agent-a", extensions, Vec::new())
    }

    fn compose_with_core(
        extensions: Vec<Box<dyn AgentExtension>>,
        core: Vec<ProtocolDescriptor>,
    ) -> Result<ExtensionRegistry, RegistryError> {
        ExtensionRegistry::new("agent-a", extensions, core)
    }

    /// A core descriptor, built the way the agent builds them.
    fn core(id: &str, wire: &str) -> ProtocolDescriptor {
        ProtocolDescriptor::new(
            id,
            crate::protocol::OWNER,
            vec![ContractDescriptor::new(ContractVersion::V1, &[wire])],
        )
        .unwrap()
    }

    #[test]
    fn a_well_formed_pair_composes_and_derives_a_manifest() {
        let registry = compose(vec![
            Box::new(Fake::new("git", "git.status", "git.status")),
            Box::new(Fake::new(
                "claude_code",
                "claude-code.read",
                "claude-code.read",
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
            Box::new(Fake::new("git", "git.status", "shared.thing")),
            Box::new(Fake::new("claude_code", "claude-code.read", "shared.thing")),
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
            text.contains("shared.thing"),
            "must name the wire type: {text}"
        );
    }

    #[test]
    fn two_providers_claiming_one_protocol_fail() {
        let err = compose(vec![
            Box::new(Fake::new("git", "shared.thing", "git.thing")),
            Box::new(Fake::new(
                "claude_code",
                "shared.thing",
                "claude-code.thing",
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
            "git.thing",
        ))])
        .unwrap_err();
        assert!(
            matches!(err, RegistryError::InvalidDeclaration { .. }),
            "got {err:?}"
        );
        assert!(err.to_string().contains("git"));
    }

    #[tokio::test]
    async fn a_declared_wire_dispatches_and_an_undeclared_one_falls_through() {
        // This used to assert the namespace strip — the wire was
        // `extension.<something>` and the extension was handed the part after
        // it. There is no strip now: the wire is the protocol id, so what the
        // extension receives is exactly what it declared.
        let registry = compose(vec![Box::new(Fake::new(
            "claude_code",
            "claude-code.read",
            "claude-code.read",
        ))])
        .unwrap();

        assert!(
            registry
                .dispatch("claude-code.read", Value::Null)
                .await
                .is_some(),
            "a declared wire type must dispatch"
        );
        assert!(
            registry.dispatch("git.status", Value::Null).await.is_none(),
            "an undeclared wire type must fall through, not be swallowed"
        );
    }

    #[test]
    fn core_units_are_advertised_beside_the_extensions() {
        // The two halves are one manifest. An agent that serves `session.create`
        // itself and `git.status` through an extension offers both, and a peer
        // resolving against it must see both — otherwise the core half is
        // invisible even though it is the half every agent has.
        let registry = compose_with_core(
            vec![Box::new(Fake::new("git", "git.status", "git.status"))],
            vec![core("session.create", "agent.session.create")],
        )
        .unwrap();

        let manifest = registry.manifest();
        assert!(manifest.offers(&ProtocolId::new("session.create").unwrap()));
        assert!(manifest.offers(&ProtocolId::new("git.status").unwrap()));
    }

    #[test]
    fn an_agent_with_no_core_units_still_composes() {
        // `DeclaresNothing` is about an *extension* that serves nothing — a
        // provider that was registered and is unreachable. Having no core units
        // is a different claim: the agent serves only what its extensions
        // declare, which is what a stripped-down build looks like.
        let registry =
            compose(vec![Box::new(Fake::new("git", "git.status", "git.status"))]).unwrap();

        let manifest = registry.manifest();
        assert!(!manifest.is_empty());
        assert!(manifest.offers(&ProtocolId::new("git.status").unwrap()));
        // Nothing was passed for the core half, so nothing is claimed for it.
        assert!(!manifest.offers(&ProtocolId::new("session.create").unwrap()));
    }

    #[test]
    fn a_core_unit_claiming_an_extension_wire_type_is_refused_and_both_are_named() {
        // Invisible in production and impossible to debug from a symptom: the
        // extension's route is in `routes`, `CORE_WIRES` answers the membership
        // test first, so the message reaches the core handler and the
        // extension's is dead — with its other wire types still working, so
        // nothing looks broken enough to investigate.
        let err = compose_with_core(
            vec![Box::new(Fake::new("git", "git.status", "shared.thing"))],
            vec![core("session.create", "shared.thing")],
        )
        .unwrap_err();

        assert!(
            matches!(err, RegistryError::DuplicateCoreWireType { .. }),
            "got {err:?}"
        );
        let text = err.to_string();
        assert!(text.contains("git"), "must name the extension: {text}");
        assert!(
            text.contains("session.create"),
            "must name the core unit: {text}"
        );
        assert!(
            text.contains("shared.thing"),
            "must name the wire type: {text}"
        );
    }

    #[test]
    fn two_core_units_claiming_one_wire_type_are_refused() {
        // The core half is a list like any other, and a copy-paste that leaves
        // the same wire type on two units would route to whichever arm came
        // first in the generated match — silently, since both compile.
        let err = compose_with_core(
            Vec::new(),
            vec![
                core("session.create", "server.thing"),
                core("session.kill", "server.thing"),
            ],
        )
        .unwrap_err();

        assert!(
            matches!(err, RegistryError::DuplicateCoreWireType { .. }),
            "got {err:?}"
        );
    }

    #[test]
    fn one_unit_on_two_transports_composes_and_keeps_both_wire_types() {
        // The agent's own dispatchers are one list per transport, and this is
        // what the union of them looks like: the same unit arriving twice, once
        // per path. Refusing it would make the agent refuse to start over a
        // unit it serves correctly, which is why the check compares units and
        // not wire types alone.
        let registry = compose_with_core(
            Vec::new(),
            vec![
                core("session.capture-preview", "agent.session.capture-preview"),
                core("session.capture-preview", "agent.session.capture-preview"),
            ],
        )
        .unwrap();

        let manifest = registry.manifest();
        let id = ProtocolId::new("session.capture-preview").unwrap();
        assert!(manifest.offers(&id));
        let support = &manifest.protocols[&id];
        assert_eq!(
            support.wire,
            vec!["agent.session.capture-preview".to_string()],
            "one wire, named once even though two paths serve it"
        );
    }

    #[test]
    fn the_agent_composes_the_units_it_actually_serves() {
        // The real composition, not a pair of `core(…)` stand-ins: the two
        // invocations that dispatch the agent's own handlers, unioned the way
        // `main` does. It fails if either list grows a unit the other cannot be
        // composed with — which is how the `session.capture_preview` overlap
        // was found.
        let core = crate::connection::core_descriptors().unwrap();
        let p2p = crate::server::websocket::p2p_descriptors().unwrap();
        let mut served = core.clone();
        served.extend(p2p.clone());

        let registry = compose_with_core(Vec::new(), served).unwrap();
        let manifest = registry.manifest();

        // 10 core units and 21 peer-to-peer ones, sharing three ids between
        // them (`session.create`, `session.kill`, `session.capture-preview`) —
        // so the union is 28, not 31.
        //
        // Spelled as a number on purpose: adding a unit should make someone read
        // this line, and the failure of a relaxed assertion is indistinguishable
        // from a unit that was never wired up.
        assert_eq!(
            manifest.protocols.len(),
            core.len() + p2p.len() - 3,
            "the union is by id, so the three shared units are counted once"
        );
        // Three, not four: `session.list` stopped being shared when the core
        // side became `session.report`. The two arms answer different questions
        // — the registry's five-field report against the full `SessionInfo` —
        // so they are two protocols, and only the exception needs justifying.
        //
        // Both this and the derived count above have moved more than once, which
        // is the argument for keeping the two together: the derived one catches
        // a wiring mistake, the literal one makes every deliberate change to the
        // surface say so out loud.
        //
        // The last move was down, and it is #953 rather than a unit going
        // missing: `agent.keepalive.ping` left the peer-to-peer list and
        // `server.agent.heartbeat` left the core one, because a control wire is
        // not a unit and a manifest does not describe one. The surface is what
        // this agent is *asked* for; a heartbeat is not asked for.
        assert_eq!(
            manifest.protocols.len(),
            28,
            "the surface is {:?}",
            manifest.protocols.keys().collect::<Vec<_>>()
        );

        // Served on both sockets: one unit, and now **one wire name** too.
        //
        // It used to be two — `server.session.create` for the relay and
        // `session.create` for the direct path — because the wire was named
        // after whoever sent it. The handler is the agent either way, so both
        // became `agent.session.create` and the name stopped being a way to
        // tell the transports apart. It should not have been one: which socket
        // a message arrived on is a transport fact, and the design says the
        // wire is the protocol's projection, not its routing.
        let both = ProtocolId::new("agent.session.create").unwrap();
        assert!(manifest.offers(&both));
        assert_eq!(
            manifest.protocols[&both].wire,
            vec!["agent.session.create".to_string()],
            "one protocol, one name, two sockets"
        );

        // Served only on the agent's own socket.
        assert!(manifest.offers(&ProtocolId::new("agent.terminal.input").unwrap()));
        assert!(manifest.offers(&ProtocolId::new("agent.file.read").unwrap()));
        // Served only on the server connection.
        assert!(manifest.offers(&ProtocolId::new("agent.env.write").unwrap()));
    }
}
