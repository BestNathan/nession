//! One Protocol Unit's request/reply pairing, and the envelope constructor.

use nession_protocol::{ContractVersion, Message};
use serde::{de::DeserializeOwned, Serialize};

/// A unit's request payload, and the reply it is answered with.
///
/// The pairing lives here and nowhere else, and that placement is the whole
/// mechanism behind #1015's requirement that a contract change cannot leave a
/// consumer silently speaking an old shape: the `Reply` associated type is what
/// the typed method returns, so a renamed or removed reply type breaks that
/// method's callers at compile time. A hand-written local DTO — what this
/// replaces — turns the same change into a *runtime* serde error, or, when the
/// local copy is narrower than the contract, into nothing at all. The
/// `AgentInfo` this boundary deleted had quietly lost eleven of
/// `WebAgentInfo`'s fields and never once complained.
///
/// Note what this trait deliberately does **not** carry: the wire name. A
/// `const WIRE` here would be a second declaration site for a string
/// `scripts/protocol-gate.mjs` already resolves from
/// [`crate::wire`], and a declaration site the gate cannot see is one that can
/// misspell.
pub trait UnitRequest: Serialize {
    /// The contract's reply type for this request. Both come from
    /// `nession_protocol::contracts::…`; neither is ever redeclared here.
    type Reply: DeserializeOwned;

    /// The contract versions this consumer can read.
    ///
    /// Declared now, consulted in stage 5, and the split is deliberate. The
    /// *other* half of resolution already exists in the kernel
    /// (`nession_protocol::resolve` / `select_version`); what Rust has never had
    /// is a place for a consumer to state its requirement, which is the half the
    /// Web has in TypeScript. Declaring it here means the requirement exists
    /// before the first two-version unit does, rather than being retrofitted
    /// once a consumer has already guessed wrong.
    ///
    /// Calling `resolve` today would be worse than not calling it: every unit
    /// this client speaks is Server-served at v1, so the call could only ever
    /// return the version it was handed. A negotiation that cannot refuse reads
    /// as a negotiation that happened.
    ///
    /// `ContractVersion::V1` is the kernel's only `const` constructor, so a unit
    /// served at v2 forces that decision — a kernel-side const, or a
    /// runtime-built list — to be made in the kernel rather than worked around
    /// in a consumer.
    const VERSIONS: &'static [ContractVersion] = &[ContractVersion::V1];
}

/// Build one request envelope, naming its wire.
///
/// The wire is a parameter rather than something the payload knows, so that it
/// is named **at a call site** with a constant from [`crate::wire`] — which is
/// where `scripts/protocol-gate.mjs` checks it against the set of wires some
/// runtime actually serves. A request built anywhere else names no wire the
/// gate can see.
///
/// The `id` is left empty on purpose. Uniqueness is a property of the
/// connection's request sequence, not of the payload, so
/// [`crate::ClientConnection::request`] assigns it — the only place that can.
/// Handing the result straight to a socket without going through that method
/// would send an uncorrelatable request, which is why the two are documented
/// as a pair.
pub fn proto_msg<P: UnitRequest>(wire: &'static str, payload: P) -> Message<P> {
    Message::new(wire, String::new(), now_millis(), payload)
}

/// Milliseconds since the Unix epoch, the envelope's stated unit.
///
/// **Milliseconds, not seconds.** The consumer this replaces sent `.as_secs()`
/// into the same field, so every request it built disagreed with the contract
/// dated it by a factor of a thousand — invisible, because nothing that
/// received one had reason to read it.
///
/// Fallible conversions are defaulted rather than propagated: a clock set
/// before 1970 is not a reason to fail a request, and the field is
/// informational for ordering and logging.
pub(crate) fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
        .unwrap_or_default()
}
