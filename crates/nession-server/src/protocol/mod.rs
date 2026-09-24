//! The Protocol Units this server serves (`#678`, Phase 6).
//!
//! The Server is a provider like any other. It serves `agent.register`,
//! `session.attach`, `env.*`, `commands.*` and the rest, and until this module
//! existed it declared none of them: its dispatch was a `match` in
//! `server/handler.rs`, and a `match` cannot be read to produce the set it
//! handles. So the Server was the one peer whose offer was invisible — an agent
//! advertised a manifest, the web resolved against it, and the server that
//! brokers both said nothing about itself.
//!
//! ## Why this is a macro, and the same macro shape as the agent
//!
//! [`core_routes!`](crate::protocol::server_routes) is the Server's answer to
//! the same problem `nession-agent`'s `core_routes!` solves, and deliberately
//! the same shape: one invocation emits the descriptor list, the wire-type set
//! and the dispatcher, so a unit cannot be advertised without a handler or
//! handled without being advertised. Two mechanisms for one rule would be a
//! second thing to keep in step.
//!
//! The hygiene constraint is identical, and so is the workaround: an identifier
//! written in a macro *definition* is distinct from the same tokens written in
//! a `$body`, so `self` cannot be captured — the dispatcher is a free function
//! taking the handler, and the bodies say `handler` where they said `self`.

use std::sync::OnceLock;

use nession_protocol::{
    ContractDescriptor, ContractVersion, IdentityError, ProtocolDescriptor, ProtocolManifest,
};

/// Who owns these contracts. Also the answer to "who do I ask when they change?"
pub const OWNER: &str = "nession-server";

/// One version, one wire message type — the shape every server unit has today.
pub(crate) fn v1_descriptor(id: &str, wire: &str) -> Result<ProtocolDescriptor, IdentityError> {
    ProtocolDescriptor::new(
        id,
        OWNER,
        vec![ContractDescriptor::new(ContractVersion::V1, &[wire])],
    )
}

/// Declare the units this server serves, once.
///
/// Invoked in `server::handler`, where `ConnectionHandler`'s private methods are
/// in scope — the bodies are the handlers, and they reach into the handler's
/// state. The macro is defined here so the declaration's identity rules live
/// with the module that owns them.
///
/// Each arm carries the **execution policy** of its unit (`#961-C`), between the
/// wire type and the body: how the connection's reader dispatches a message of
/// that unit. It is a column here for the same reason the id and the wire are —
/// one invocation, so a unit cannot be handled without being advertised, or
/// advertised without a policy, and the policy acts on a Protocol Unit rather
/// than on a name prefix. `server::execution` owns what the policies mean.
///
/// The policy is an **expression over the payload** (`#961-E`) rather than a
/// constant, because one of the four policies needs one: `Key` carries the
/// resource the frame mutates, and which field of which payload names that
/// resource is a property of the operation. `server.session.create` names its
/// target with an `agent_id` and a `name`, `server.session.kill` names the same
/// resource with one joined `session_id`, and nothing about either wire says so.
/// Deriving the key from the wire name instead is the `extension.*`-shaped guess
/// the constraints rule out, so the rule is written where the rest of the
/// operation is.
///
/// The payload is a **reference** here, which is the one asymmetry with
/// `dispatch_server` below: the policy is read before the arm runs, and the arm
/// consumes the payload, so this half may only look at it.
macro_rules! server_routes {
    ($handler:ident, $msg:ident, $payload:ident $(,)? ; $( $id:literal => $wire:literal => $policy:expr => $body:expr ),* $(,)?) => {
        /// Every Protocol Unit this server serves on its client and agent
        /// connections.
        ///
        /// Derived from the same invocation that dispatches them, so this list
        /// is what the server *does* rather than what someone remembered to
        /// write down.
        pub fn server_descriptors() -> Result<
            Vec<nession_protocol::ProtocolDescriptor>,
            nession_protocol::IdentityError,
        > {
            Ok(vec![$( $crate::protocol::v1_descriptor($id, $wire)?, )*])
        }

        /// The wire types the same invocation covers.
        ///
        /// The message loop asks this before dispatching, so a message the
        /// server does not serve falls through to the tail match rather than
        /// into `dispatch_server`'s empty arm.
        pub(crate) const SERVER_WIRES: &[&str] = &[$( $wire, )*];

        /// How the connection's reader dispatches one wire (`#961-C`, `#961-E`).
        ///
        /// `None` for a wire this server does not serve — a control wire, a wire
        /// it only forwards to an agent, or something nobody serves. The
        /// connection reads that as its declared default rather than guessing
        /// from the name; see `server::execution`.
        pub(crate) fn unit_policy(
            wire: &str,
            $payload: &serde_json::Value,
        ) -> Option<$crate::server::execution::ExecutionPolicy> {
            match wire {
                $( $wire => Some($policy), )*
                _ => None,
            }
        }

        /// Route one message to the handler that serves it.
        ///
        /// A free function rather than a method: `self` written in this
        /// definition would be hygienically distinct from the `self` the bodies
        /// mention, and there is no way to pass `self` in as an identifier. The
        /// caller has already established that `$msg.msg_type` is in
        /// [`SERVER_WIRES`].
        pub(crate) async fn dispatch_server(
            $handler: &mut ConnectionHandler,
            $msg: ProtocolMessage<serde_json::Value>,
        ) -> anyhow::Result<HandlerAction> {
            // The wire type is taken by value before the match, not borrowed
            // in the scrutinee. The agent's dispatcher can match on
            // `$msg.msg_type.as_str()` because its handlers borrow the message;
            // these take it **by value**, so a borrow held across the match
            // would conflict with every arm that moves it. One small allocation
            // per message, and the alternative is rewriting every handler's
            // signature to no purpose.
            let msg_type = $msg.msg_type.clone();
            match msg_type.as_str() {
                $( $wire => $body, )*
                // Unreachable through the caller's membership test. Kept
                // rather than `unreachable!()` so a message that slips past it
                // is answered the way the tail match answers anything unknown.
                _ => Ok(HandlerAction::Reply(None)),
            }
        }
    };
}

pub(crate) use server_routes;

/// What this Server offers, built once.
///
/// Built from [`server_descriptors`] on first use rather than held as a field,
/// because the manifest is a pure function of the declaration: caching it in
/// the server's state would make it something that could be constructed *wrong*
/// — an empty one, or one from a different declaration — which is the class of
/// mistake deriving it exists to remove.
///
/// Fallible rather than panicking, like every other composition boundary here:
/// a declaration that names itself badly is a programming error, and the way
/// this crate reports those is a `Result` the tests unwrap, not a panic in a
/// request path. Every id and wire type is a literal in one file, so the error
/// is unreachable in practice — which is exactly why it should not be a panic
/// waiting in a rarely-taken branch.
pub fn server_manifest() -> Result<&'static ProtocolManifest, IdentityError> {
    static MANIFEST: OnceLock<ProtocolManifest> = OnceLock::new();
    if let Some(manifest) = MANIFEST.get() {
        return Ok(manifest);
    }
    let descriptors = crate::server::server_descriptors()?;
    Ok(MANIFEST.get_or_init(|| ProtocolManifest::from_descriptors(OWNER, &descriptors)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_owner_names_this_crate() {
        // The owner is what a peer reads to know who to ask when a contract
        // moves. A rename here that the directory did not follow would send
        // them to a crate that is not there.
        assert_eq!(OWNER, env!("CARGO_PKG_NAME"));
    }

    #[test]
    fn a_descriptor_names_its_unit_its_owner_and_its_wire_type() {
        let d = v1_descriptor("session.attach", "server.session.attach").unwrap();
        assert_eq!(d.id.as_str(), "session.attach");
        assert_eq!(d.owner, OWNER);
        assert_eq!(
            d.contracts[0].wire,
            vec!["server.session.attach".to_string()]
        );
        assert!(d.validate().is_ok());
    }

    #[test]
    fn the_manifest_lists_every_unit_the_declaration_names() {
        // Derived, so this is a statement about the invocation rather than a
        // number someone has to maintain. The point is that it is not zero and
        // that every wire the declaration carries reaches the manifest — a
        // manifest that silently dropped one would understate this peer, which
        // is the failure the derivation exists to make impossible.
        let descriptors = crate::server::server_descriptors().unwrap();
        let manifest = server_manifest().unwrap();

        assert_eq!(manifest.provider, OWNER);
        assert!(!descriptors.is_empty());

        for descriptor in &descriptors {
            for contract in &descriptor.contracts {
                for wire in &contract.wire {
                    assert!(
                        manifest.carries(wire),
                        "`{wire}` is declared but absent from the manifest"
                    );
                }
            }
        }
    }

    #[test]
    fn an_id_that_is_not_canonical_is_refused_rather_than_renamed() {
        // The spelling is the point of this test, so it is not a typo and must
        // not be "corrected": `session.capture_preview` with an underscore is
        // not an id, and `ProtocolId` refuses it rather than quietly renaming
        // it. Writing the canonical spelling here would leave `is_err()`
        // asserting nothing at all.
        //
        // The two calls differ only in the id's spelling, so the first failing
        // and the second succeeding is the whole rule.
        assert!(
            v1_descriptor("session.capture_preview", "server.session.capture-preview").is_err()
        );
        assert!(v1_descriptor("session.capture-preview", "server.session.capture-preview").is_ok());
    }
}
