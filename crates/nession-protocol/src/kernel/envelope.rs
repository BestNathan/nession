//! The one message envelope.
//!
//! Every Nession message on every transport is this shape, and there is
//! deliberately only one definition of it. Before this crate there were two —
//! `nession-common::protocol::Message` and
//! `nession-agent::server::websocket::Message` — with identical fields, kept in
//! step by nothing. Two definitions of a framing contract is two answers to
//! "what is a message", and the wire only has room for one.
//!
//! ## What is not in here
//!
//! No contract version, no protocol id, no target. The design is explicit that
//! call context belongs in the payload of the operations that need it, not in
//! the envelope every message carries — an envelope field is paid for by every
//! protocol, including the ones with nothing to put in it.
//!
//! The envelope therefore stays what it always was: who this is for
//! (`msg_type`), which exchange it belongs to (`id`), when it was made
//! (`timestamp`), and the body.

use serde::{Deserialize, Serialize};

/// A protocol message.
///
/// `T` is the payload. Consumers that have not yet typed a contract use
/// `serde_json::Value`; the design's rule is that this is a *dispatcher*
/// convenience and never a contract — the payload shape of a fixed protocol
/// belongs in a typed struct, not in a `Value` everyone re-parses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message<T> {
    /// The wire message type. This is the contract's transport projection, not
    /// the protocol's identity — see [`super::identity`].
    pub msg_type: String,
    /// Correlates a response with its request. Unique per exchange, not
    /// globally.
    pub id: String,
    /// Milliseconds since the Unix epoch, from the sender's clock.
    ///
    /// A `u64` of milliseconds, stated because the unit is the kind of thing
    /// that is silently assumed: the design requires timestamp units be
    /// explicit in contract evidence.
    pub timestamp: u64,
    pub payload: T,
}

impl<T> Message<T> {
    pub fn new(
        msg_type: impl Into<String>,
        id: impl Into<String>,
        timestamp: u64,
        payload: T,
    ) -> Self {
        Self {
            msg_type: msg_type.into(),
            id: id.into(),
            timestamp,
            payload,
        }
    }

    /// Re-frame this message with a different payload.
    ///
    /// The routing fields are carried over unchanged, which is what makes a
    /// response correlate: building one by hand is how an `id` gets dropped and
    /// a caller waits forever.
    pub fn map_payload<U>(self, f: impl FnOnce(T) -> U) -> Message<U> {
        Message {
            msg_type: self.msg_type,
            id: self.id,
            timestamp: self.timestamp,
            payload: f(self.payload),
        }
    }
}

/// The historical alias, kept because the design documents and existing call
/// sites use both spellings for the same type.
pub type ProtocolMessage<T> = Message<T>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_historical_wire_shape() {
        // The envelope is a framing contract with peers that already exist, so
        // its field names and order are not ours to improve. Pinned rather than
        // assumed, because a rename here is a silent incompatibility.
        let msg = Message::new("extension.git.status", "req-42", 1_789_000_000_000, 7u8);
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["msg_type"], "extension.git.status");
        assert_eq!(json["id"], "req-42");
        assert_eq!(json["timestamp"], 1_789_000_000_000u64);
        assert_eq!(json["payload"], 7);
        assert_eq!(json.as_object().unwrap().len(), 4);
    }

    #[test]
    fn map_payload_carries_the_routing_fields_over() {
        // The failure this prevents is a response built by hand that forgets
        // the id, leaving the caller waiting for a reply that never lands.
        let request = Message::new("client.env.list", "req-7", 99, vec![1, 2]);
        let response = request.map_payload(|v| v.len());
        assert_eq!(response.id, "req-7");
        assert_eq!(response.msg_type, "client.env.list");
        assert_eq!(response.timestamp, 99);
        assert_eq!(response.payload, 2);
    }

    #[test]
    fn a_payload_type_that_is_not_an_object_still_round_trips() {
        // `Message<T>` is generic over the payload, and both existing
        // definitions instantiated it at `Value` *and* at structs; nothing may
        // assume the payload is a map.
        let msg = Message::new("x.y", "id", 1, vec![1u8, 2, 3]);
        let text = serde_json::to_string(&msg).unwrap();
        let back: Message<Vec<u8>> = serde_json::from_str(&text).unwrap();
        assert_eq!(back, msg);
    }

    #[test]
    fn the_alias_is_the_same_type() {
        let via_alias: ProtocolMessage<u8> = Message::new("a.b", "id", 1, 1);
        let direct: Message<u8> = via_alias;
        assert_eq!(direct.payload, 1);
    }
}
