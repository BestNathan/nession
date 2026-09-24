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
//! core_routes! { "session.create" => "agent.session.create" => { …body… } }
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
//! What `server_client`'s match beside the dispatcher handles, and what no arm
//! of this macro may be:
//!
//! - the server's acceptance of `server.agent.register`. A reply carries its
//!   request's own wire name (#953, Rule 1), so the agent reads it under a name
//!   it already has — and it is not a unit *this* agent serves, because a
//!   manifest advertising it would claim an offer that does not exist;
//! - the three **control** wires (`control.heartbeat`, `control.ping`,
//!   `control.pong`). They are the third category — not operations, which have
//!   one answerer, and not notifications, which have one emitter — so an arm
//!   here would be wrong twice over: it would advertise a unit that is not one,
//!   and it would describe a message as an offer when the whole point is that
//!   every runtime handles it and nothing answers it.
//!
//! That rule is stated canonically in `docs/architecture/protocol.md` § *What is
//! not a Protocol Unit*, and shortened to its test on the `Unit` type in
//! `catalog.rs`. It is repeated here only because this is where it explains a
//! local absence — if the three ever disagree, those two are right and this is a
//! stale copy.

use nession_protocol::{ContractDescriptor, ContractVersion, IdentityError, ProtocolDescriptor};

/// Who owns these contracts. Also the answer to "who do I ask when they change?"
pub const OWNER: &str = "nession-agent";

/// One Contract Version of one wire message type (`#963`).
///
/// Takes the version rather than assuming `V1`: the wire locates the Protocol
/// Unit and the version selects the generation, so a unit serving two
/// generations states both and this is how a table says which is which.
pub(crate) fn descriptor(
    id: &str,
    wire: &str,
    version: u32,
) -> Result<ProtocolDescriptor, IdentityError> {
    ProtocolDescriptor::new(
        id,
        OWNER,
        vec![ContractDescriptor::new(
            ContractVersion::new(version)?,
            &[wire],
        )],
    )
}

/// The `contract_version` a payload names, or `1` when it names none.
///
/// **Absent means v1**, and that is the rule the routing tables are built on:
/// a caller that names no version is addressing the unit as it was before
/// versions existed, which is v1 by definition. It is also why the tables can
/// match on a plain `(wire, version)` tuple — two generations are two distinct
/// patterns, where two arms on one wire alone would make the second
/// unreachable and `-D warnings` would fail the build.
///
/// A `contract_version` that is present but not a number also resolves to `1`.
/// That is looser than `ExtensionRegistry`'s check, which refuses it, and the
/// difference is deliberate for now: this is the macro's routing contract, and
/// making *this* layer refuse is `#963` Stage 3's decision — the one about how
/// wide the refusal should be. Recorded here rather than left to be discovered.
pub(crate) fn named_contract_version(payload: &serde_json::Value) -> u32 {
    payload
        .get("contract_version")
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(1)
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
///
/// ## The execution policy column (`#961-E`)
///
/// Each arm also states **how the connection's reader dispatches it**, between
/// the wire type and the body — the same column-on-the-row shape the peer-to-peer
/// `p2p_routes!` and the Server's `server_routes!` use, and for the same reason:
/// one invocation, so a unit cannot be handled without being advertised, or
/// advertised without a lane. What the policies mean is
/// `crate::connection::execution`'s to say.
///
/// As on the peer-to-peer socket, the policy is an *expression over the
/// payload* rather than a constant, because `Key` carries the resource the
/// frame mutates and which field of which payload names that resource is a
/// property of the operation. It matters more here than there: every unit on
/// this connection names its target in a field called `name`, and only the
/// operation knows whether that name is a tmux session or an env file. The
/// payload is a **reference** here for the same reason as there — the policy is
/// read before the arm runs, and the arm consumes the payload.
macro_rules! core_routes {
    ($client:ident, $msg:ident, $responses:ident $(,)? ; $( $id:literal => $wire:literal => $version:literal => $policy:expr => $body:block )* $(,)?) => {
        /// Every Protocol Unit this agent serves on its server connection.
        ///
        /// Derived from the same invocation that dispatches them, so this list
        /// is what the agent *does* rather than what someone remembered to
        /// write down.
        ///
        /// **One descriptor per arm, so a unit at two versions emits two.**
        /// They carry the same id and different versions, and
        /// `ProtocolManifest::from_descriptors` unions them into one entry
        /// advertising `[1, 2]` — which is the shape `#963` exists to make
        /// expressible. Emitting one descriptor per *wire* instead would have
        /// to pick a version, and picking is the manifest's job.
        pub fn core_descriptors() -> Result<
            Vec<nession_protocol::ProtocolDescriptor>,
            nession_protocol::IdentityError,
        > {
            Ok(vec![$( crate::protocol::descriptor($id, $wire, $version)?, )*])
        }

        /// The wire types the same invocation covers.
        ///
        /// The message loop asks this before dispatching, so a message the
        /// agent does not serve falls through to the notification match rather
        /// than into `dispatch_core`'s empty arm.
        ///
        /// A unit serving two versions appears once per version here. Membership
        /// is the only question asked of it, so the repeat is harmless — and
        /// deduping it would need a `const` map that cannot be built.
        pub(crate) const CORE_WIRES: &[&str] = &[$( $wire, )*];

        /// How the connection's reader dispatches one wire (`#961-E`).
        ///
        /// `None` for a wire this agent does not serve on this connection — a
        /// control wire, an extension's own command unit, or a name nobody
        /// answers. The reader reads that as its declared default rather than
        /// guessing from the name; see `crate::connection::execution`.
        ///
        /// Keyed on `(wire, version)`, so the first arm that names a version
        /// wins and an arm for version 2 cannot shadow version 1. Two
        /// generations of one unit may declare different policies, and then each
        /// gets the one it declared.
        pub(crate) fn core_policy(
            $msg: &ProtocolMessage<serde_json::Value>,
        ) -> Option<crate::connection::execution::ExecutionPolicy> {
            match (
                $msg.msg_type.as_str(),
                crate::protocol::named_contract_version(&$msg.payload),
            ) {
                $( ($wire, $version) => Some($policy), )*
                _ => None,
            }
        }

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
            $responses: &mpsc::Sender<WsMessage>,
        ) -> Result<()> {
            match (
                $msg.msg_type.as_str(),
                crate::protocol::named_contract_version(&$msg.payload),
            ) {
                $( ($wire, $version) => $body, )*
                // Unreachable through the caller's membership test for a unit
                // this table serves, and reachable for a message that names a
                // version no arm declares — which is ignored rather than
                // refused, matching what this loop did before. `#963` Stage 3
                // owns making it a refusal.
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
/// Same test as [`core_routes`]: is it an offer a peer can call? A handler that
/// exists and is not advertised is one of the two states this macro exists to
/// make unconstructible, and carving out an exception for an arm that feels
/// unworthy would put the list back in someone's memory.
///
/// `control.ping` used to be the arm that tested this, kept here thinly because
/// it had a handler and no honest claim to being an offer. It is gone from this
/// list, and the test it prompted is now answered by the category rather than
/// by an exception: control wires are handled beside the route table in
/// `server::websocket`, and the reason they are not here is that they are not
/// offers at all.
///
/// ## The execution policy column (`#961-D`)
///
/// Each arm also states **how the connection's reader dispatches it**, between
/// the wire type and the body — the same column-on-the-row shape the Server's
/// `server_routes!` uses (`nession-server`'s `server::execution`), and for the
/// same reason: one invocation, so a unit cannot be handled without being
/// advertised, or advertised without a lane. What the policies mean is
/// `crate::server::execution`'s to say.
///
/// The difference from the Server's column is that this one is an *expression*
/// over the payload rather than a constant, because two of the four policies
/// need one: `Key` carries the resource the frame mutates, and which field of
/// which payload names that resource is a property of the operation — a
/// `session.kill` names its target `name` and a `terminal.input` names it
/// `session_name`, and nothing about either wire says so. Deriving the key from
/// the wire name instead is the `extension.*`-shaped guess the constraints rule
/// out, so the rule is written where the rest of the operation is.
///
/// The payload is a **reference** here, which is the one asymmetry with the
/// dispatcher below: the policy is read before the arm runs, and the arm
/// consumes the payload, so this half may only look at it.
macro_rules! p2p_routes {
    ($ctx:ident, $msg_type:ident, $payload:ident $(,)? ; $( $id:literal => $wire:literal => $version:literal => $policy:expr => $body:block )* $(,)?) => {
        /// Every Protocol Unit this agent serves on its peer-to-peer socket.
        ///
        /// Unioned with [`crate::connection::core_descriptors`] into the one
        /// manifest the agent registers — a unit on both lists is one unit with
        /// two wires.
        pub fn p2p_descriptors() -> Result<
            Vec<nession_protocol::ProtocolDescriptor>,
            nession_protocol::IdentityError,
        > {
            Ok(vec![$( crate::protocol::descriptor($id, $wire, $version)?, )*])
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

        /// How the connection's reader dispatches one peer-to-peer frame
        /// (`#961-D`).
        ///
        /// `None` for a wire this agent does not serve on this socket — a
        /// control wire, or a name nobody answers. The reader reads that as its
        /// declared default rather than guessing from the name; see
        /// `crate::server::execution`.
        pub(crate) fn p2p_policy(
            $msg_type: &str,
            $payload: &serde_json::Value,
        ) -> Option<crate::server::execution::ExecutionPolicy> {
            match ($msg_type, crate::protocol::named_contract_version($payload)) {
                $( ($wire, $version) => Some($policy), )*
                _ => None,
            }
        }

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
            match ($msg_type, crate::protocol::named_contract_version(&$payload)) {
                $( ($wire, $version) => $body, )*
                (unknown, _) => $ctx.err(
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
        let d = descriptor("session.create", "agent.session.create", 1).unwrap();
        assert_eq!(d.id.as_str(), "session.create");
        assert_eq!(d.owner, OWNER);
        assert_eq!(
            d.contracts[0].wire,
            vec!["agent.session.create".to_string()]
        );
        assert!(d.validate().is_ok());
    }

    #[test]
    fn an_id_that_is_not_canonical_is_refused_rather_than_renamed() {
        // `ProtocolId` refuses underscores, so a provider that passed a wire
        // string through as its id would get one the registry rejects. The
        // capture-preview unit is where this bit: its wire was
        // `session.capture_preview` and its id `session.capture-preview`.
        //
        // The wire is the id now — one spelling — so the two arguments below
        // are the same string by construction, and what the test pins is that
        // the *id* form is the one that has to be canonical.
        assert!(
            descriptor(
                "agent.session.capture_preview",
                "agent.session.capture-preview",
                1
            )
            .is_err(),
            "an id with an underscore is not canonical and must be refused"
        );
        assert!(descriptor(
            "agent.session.capture-preview",
            "agent.session.capture-preview",
            1
        )
        .is_ok());
    }
}
