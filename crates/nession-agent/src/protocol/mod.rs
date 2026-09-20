//! The Protocol Units this agent serves (`#678`, Phase 6).
//!
//! The extensions are declared by the extensions themselves — each
//! `AgentExtension` answers `descriptors()`, and [`crate::extension`] derives
//! its routes from that. The core protocols have no such object: they are
//! methods on `ServerClient`, reached by a `match` on the wire type.
//!
//! ## Why this is a macro
//!
//! A `match` cannot be read to produce the set it handles, so "the units we
//! advertise" and "the units we dispatch" would be two lists — and the design's
//! objection to two lists is that they drift silently. `ExtensionRegistry`'s
//! answer is to *derive* the routes from the descriptors; the equivalent here
//! is one invocation that emits both:
//!
//! ```text
//! core_routes! { "session.create" => "server.session.create" => { …body… } }
//!        ├── core_descriptors()   the manifest's half
//!        └── dispatch_core()      the routing half
//! ```
//!
//! Neither half can name a unit the other does not, because there is one list.
//! The bodies are the arms that used to sit in `handle_server_message`, moved
//! verbatim — the alternative, a table of function pointers, would have meant
//! boxing every future for no gain in guarantee.
//!
//! ## What is not here
//!
//! Notifications — `agent.register.response`, `server.heartbeat.ack` — stay in
//! the match in `server_client`. They are replies to something the agent sent,
//! not units anyone can call, and a manifest that advertised them would be
//! claiming an offer that does not exist.

use nession_protocol::{ContractDescriptor, ContractVersion, IdentityError, ProtocolDescriptor};

/// Who owns these contracts. Also the answer to "who do I ask when they change?"
pub const OWNER: &str = "nession-agent";

/// One version, one wire message type — the shape every core unit has today.
///
/// The same helper the other providers use, for the same reason: a unit that
/// needs something else states it itself, and this one exists so six do not
/// each restate it.
pub(crate) fn v1_descriptor(id: &str, wire: &str) -> Result<ProtocolDescriptor, IdentityError> {
    ProtocolDescriptor::new(
        id,
        OWNER,
        vec![ContractDescriptor::new(ContractVersion::V1, &[wire])],
    )
}

/// Declare the units this agent serves, once.
///
/// Invoked in `connection::server_client`, where `ServerClient`'s private
/// fields are in scope — the bodies are the message handlers, and they reach
/// into the client's state. The macro is defined here so the declaration's
/// identity rules live with the module that owns them.
/// Every identifier the generated code and the bodies share is named by the
/// *invocation*, not here. A `$body` keeps the call site's syntax context, so a
/// name written in this definition is a different identifier from the one the
/// body mentions — `self` included, which is why the dispatcher is a free
/// function taking the client rather than a method, and why the bodies say
/// `agent` where they used to say `self`.
macro_rules! core_routes {
    ($client:ident, $msg:ident, $responses:ident $(,)? ; $( $id:literal => $wire:literal => $body:block )* $(,)?) => {
        /// Every Protocol Unit this agent serves on its server connection.
        ///
        /// Derived from the same invocation that dispatches them, so this list
        /// is what the agent *does* rather than what someone remembered to
        /// write down.
        pub fn core_descriptors() -> Result<
            Vec<nession_protocol::ProtocolDescriptor>,
            nession_protocol::IdentityError,
        > {
            Ok(vec![$( crate::protocol::v1_descriptor($id, $wire)?, )*])
        }

        /// The wire types the same invocation covers.
        ///
        /// The message loop asks this before dispatching, so a message the
        /// agent does not serve falls through to the notification match rather
        /// than into `dispatch_core`'s empty arm.
        pub(crate) const CORE_WIRES: &[&str] = &[$( $wire, )*];

        /// Route one server-sent message to the handler that serves it.
        ///
        /// A free function rather than a method: `self` written in this
        /// definition would be hygienically distinct from the `self` the bodies
        /// mention, and there is no way to pass `self` in as an identifier. The
        /// caller has already established that `$msg.msg_type` is in
        /// [`CORE_WIRES`].
        pub(crate) async fn dispatch_core(
            $client: &ServerClient,
            $msg: &ProtocolMessage<serde_json::Value>,
            $responses: &mpsc::UnboundedSender<WsMessage>,
        ) -> Result<()> {
            match $msg.msg_type.as_str() {
                $( $wire => $body, )*
                // Unreachable through the caller's membership test. Kept
                // rather than `unreachable!()` so a message that slips past it
                // is ignored, which is what this loop did before.
                _ => {}
            }
            Ok(())
        }
    };
}

pub(crate) use core_routes;

/// Declare the units this agent serves **on its own socket**, once.
///
/// The same shape as [`core_routes`], for the same reason: a `match` cannot be
/// read to produce the set it handles, so a hand-written list of the peer-to-peer
/// wires would be a second list, free to drift from the arms it claims to
/// describe. Invoked in `server::websocket`, where the request context and the
/// handlers' helpers are in scope.
///
/// ## Why this is a second invocation rather than more arms on the first
///
/// The two dispatchers are reached by different transports and are the same
/// provider either way. A unit served on both is **one unit** — `session.create`
/// is answered for the central server on `server.session.create` and for a
/// browser on `session.create` — so the two lists are *unioned by id* into one
/// manifest ([`ProtocolManifest::from_descriptors`]), which is exactly the
/// several-wires-one-unit case that function keeps both of.
///
/// The alternative — one macro invocation emitting both dispatchers — would have
/// to reconcile two different contexts (a `ServerClient` and a `P2pRequest`) and
/// two different return types, for no guarantee the two invocations do not
/// already give: each half is derived from its own arms.
///
/// ## What is not here
///
/// Same test as [`core_routes`]: is it an offer a peer can call? `keepalive.ping`
/// passes it, thinly, and is declared — a handler that exists and is not
/// advertised is one of the two states this macro exists to make
/// unconstructible, and carving out an exception for the one arm that feels
/// unworthy would put the list back in someone's memory.
macro_rules! p2p_routes {
    ($ctx:ident, $msg_type:ident, $payload:ident $(,)? ; $( $id:literal => $wire:literal => $body:block )* $(,)?) => {
        /// Every Protocol Unit this agent serves on its peer-to-peer socket.
        ///
        /// Unioned with [`crate::connection::core_descriptors`] into the one
        /// manifest the agent registers — a unit on both lists is one unit with
        /// two wires.
        pub fn p2p_descriptors() -> Result<
            Vec<nession_protocol::ProtocolDescriptor>,
            nession_protocol::IdentityError,
        > {
            Ok(vec![$( crate::protocol::v1_descriptor($id, $wire)?, )*])
        }

        /// The wire types the same invocation covers.
        ///
        /// Read by the tests that hold this list against the message-type
        /// constants, so a request wire that exists as a constant and not as an
        /// arm is a failing test rather than an arm nobody notices is missing
        /// — and the other way round, which is what catches a wire written as a
        /// literal instead of the constant that is supposed to name it.
        ///
        /// Test-only, and deliberately: unlike `CORE_WIRES`, nothing in the
        /// agent gates on it at runtime, because there is no second match for an
        /// unrouted peer-to-peer message to fall through to.
        #[cfg(test)]
        pub(crate) const P2P_WIRES: &[&str] = &[$( $wire, )*];

        /// Route one peer-to-peer request to the handler that serves it.
        ///
        /// A free function for the same hygiene reason as `dispatch_core`: a
        /// name written in this definition is a different identifier from the
        /// one a `$body` mentions, `self` included. The context is passed in
        /// rather than reached for, which is what `P2pRequest` is.
        ///
        /// Returns the reply as JSON text — the caller writes it to the socket.
        /// The arms return early on some paths, so this returns their value
        /// rather than collecting it.
        pub(crate) async fn dispatch_p2p(
            $ctx: crate::server::websocket::P2pRequest<'_>,
            $msg_type: &str,
            $payload: serde_json::Value,
        ) -> String {
            match $msg_type {
                $( $wire => $body, )*
                unknown => $ctx.err(
                    "unknown_message_type",
                    &format!("unknown message type: {unknown}"),
                ),
            }
        }
    };
}

pub(crate) use p2p_routes;

/// Every Protocol Unit this agent serves, whoever answers it.
///
/// The union of the two invocations that dispatch the agent's own handlers:
/// [`crate::connection::core_descriptors`] for the central-server connection and
/// [`crate::server::websocket::p2p_descriptors`] for the socket an agent listens
/// on. Unioned by id into the one manifest the agent registers
/// ([`ProtocolManifest::from_descriptors`]), because it is one provider: a unit
/// answered on both paths is one unit with two wires.
///
/// This exists so **the composition has one spelling**. `main` needs it, and so
/// does every test that wants the manifest a real agent sends — and a test that
/// composes its own subset is a test of a runtime that does not exist. Two of
/// them did, each gathering `core_descriptors` alone, which is how a change to
/// the union could have gone unnoticed by both.
pub fn served_descriptors() -> Result<Vec<ProtocolDescriptor>, IdentityError> {
    let mut served = crate::connection::core_descriptors()?;
    served.extend(crate::server::websocket::p2p_descriptors()?);
    Ok(served)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_owner_names_this_crate() {
        // The owner is what a peer reads to know who to ask when a contract
        // moves. `nession-agent` is the crate, and a rename here that the
        // directory did not follow would send them to a crate that is not there.
        assert_eq!(OWNER, env!("CARGO_PKG_NAME"));
    }

    #[test]
    fn a_descriptor_names_its_unit_its_owner_and_its_wire_type() {
        let d = v1_descriptor("session.create", "server.session.create").unwrap();
        assert_eq!(d.id.as_str(), "session.create");
        assert_eq!(d.owner, OWNER);
        assert_eq!(
            d.contracts[0].wire,
            vec!["server.session.create".to_string()]
        );
        assert!(d.validate().is_ok());
    }

    #[test]
    fn an_id_that_is_not_canonical_is_refused_rather_than_renamed() {
        // `session.capture_preview` is the wire; the id is
        // `session.capture-preview`, because `ProtocolId` refuses underscores.
        // A provider that passed the wire string through would get an id the
        // registry rejects, and this is where that surfaces.
        assert!(v1_descriptor("session.capture_preview", "session.capture_preview").is_err());
        assert!(v1_descriptor("session.capture-preview", "session.capture_preview").is_ok());
    }
}
