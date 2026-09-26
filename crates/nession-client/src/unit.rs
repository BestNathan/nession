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

/// Build one envelope, naming its wire.
///
/// The wire is a parameter rather than something the payload knows, so that it
/// is named **at a call site** with a constant from [`crate::wire`] — which is
/// where `scripts/protocol-gate.mjs` checks it against the set of wires some
/// runtime actually serves. A frame built anywhere else names no wire the gate
/// can see.
///
/// Bound on `Serialize` rather than [`UnitRequest`], because not every unit has
/// a reply to pair with: `agent.terminal.input` and `agent.terminal.resize` are
/// **one-way by the contract's own model** (`response: None` in the catalog,
/// with a comment saying the absence is the statement rather than a gap), and a
/// keystroke has no answer to type. [`crate::ClientConnection::request`] is the
/// half that needs a reply, and it asks for `UnitRequest` itself.
///
/// The `id` is a UUID, and [`crate::ClientConnection::request`] **overwrites it**
/// with its own per-connection sequence — uniqueness is a property of that
/// sequence, so the connection's number is the better one. The UUID is here for
/// the frames that have no connection behind them: an `agent.attach` sent on a
/// socket about to become a terminal, a keystroke. Those are sent and not
/// awaited, and the envelope still requires an `id`, so leaving it empty would
/// put a value on the wire that only looks like one.
pub fn proto_msg<P: Serialize>(wire: &'static str, payload: P) -> Message<P> {
    Message::new(
        wire,
        uuid::Uuid::new_v4().to_string(),
        now_millis(),
        payload,
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The unit is milliseconds, and a value that is *plausible* either way is
    /// exactly why this is asserted rather than assumed. Seconds and
    /// milliseconds differ by three orders of magnitude, so a floor above any
    /// second-valued timestamp catches the mistake the old consumer made —
    /// it sent `.as_secs()` into this field and nothing that received one had
    /// reason to check.
    #[test]
    fn the_timestamp_is_milliseconds() {
        let frame = proto_msg("agent.terminal.input", serde_json::json!({}));

        assert!(
            frame.timestamp > 1_000_000_000_000,
            "a second-valued timestamp is ~1.7e9; milliseconds are ~1.7e12 (got {})",
            frame.timestamp
        );
    }

    /// Every frame carries a usable `id`, including the ones nothing correlates.
    ///
    /// These are the frames with no connection behind them — a keystroke, an
    /// attach sent on a socket about to become a terminal. Nothing awaits a
    /// reply, but the envelope still requires the field, and an empty string is
    /// a value that only looks like one.
    #[test]
    fn a_frame_built_without_a_connection_still_has_an_id() {
        let frame = proto_msg("agent.terminal.input", serde_json::json!({}));

        assert_eq!(frame.msg_type, "agent.terminal.input");
        assert!(!frame.id.is_empty(), "the envelope requires an id");
    }

    /// Two frames built back to back do not share an id.
    #[test]
    fn two_frames_do_not_share_an_id() {
        let first = proto_msg("agent.terminal.input", serde_json::json!({}));
        let second = proto_msg("agent.terminal.input", serde_json::json!({}));

        assert_ne!(first.id, second.id);
    }
}
