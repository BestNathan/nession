//! The transport-neutral WebSocket frame vocabulary (`#3548`).
//!
//! The Server's and Agent's inbound dispatch and their bounded outbound queues
//! speak [`WsFrame`]. Axum owns the HTTP/WebSocket upgrade ([`crate::ingress`]),
//! and the Server's Relay and the Agent's central connector still dial peers
//! with `tokio-tungstenite`; those are transport adapters, and they convert at
//! their own edge through [`WsFrame::from_tungstenite`] and
//! [`WsFrame::into_tungstenite`].
//!
//! This is a **frame** vocabulary, not a second protocol. `ProtocolMessage`,
//! the control contracts, routing, authentication and the bounded queues keep
//! their existing owners; only the type a socket read produces and a socket
//! write consumes lives here.

use std::fmt;

/// The close frame a peer sends or receives.
///
/// The wire carries a numeric close code and a UTF-8 reason. Neither Axum's nor
/// tungstenite's own close type is used because each names its transport, and
/// this type is what both adapters convert to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsCloseFrame {
    /// The WebSocket close code as it appears on the wire (`1000`, `1001`, …).
    pub code: u16,
    /// The close reason, decoded as UTF-8 by both transports before this type
    /// exists.
    pub reason: String,
}

/// One WebSocket message, independent of the transport that carried it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsFrame {
    /// A text frame. Envelopes, terminal input and every protocol message are
    /// text; the transport has already validated UTF-8.
    Text(String),
    /// A binary frame. The protocol does not currently route one, but the
    /// transport vocabulary must carry it rather than dropping it.
    Binary(Vec<u8>),
    /// A ping control frame.
    Ping(Vec<u8>),
    /// A pong control frame.
    Pong(Vec<u8>),
    /// A close control frame, with the optional code/reason.
    Close(Option<WsCloseFrame>),
}

impl WsFrame {
    /// A text frame, spelled like the transports' own constructor.
    pub fn text(message: impl Into<String>) -> Self {
        Self::Text(message.into())
    }

    /// The payload length this frame charges the outbound budget.
    ///
    /// Deliberately the same arithmetic the pre-`#3548` transport type used: the
    /// text/binary/control payload, and for a close frame only its reason (the
    /// two-byte code is covered by [`crate::outbound::FRAME_OVERHEAD`]). The
    /// queue is a byte bound, so changing this would silently change a bound.
    pub fn len(&self) -> usize {
        match self {
            Self::Text(text) => text.len(),
            Self::Binary(data) | Self::Ping(data) | Self::Pong(data) => data.len(),
            Self::Close(frame) => frame.as_ref().map_or(0, |frame| frame.reason.len()),
        }
    }

    /// Whether the frame carries no payload.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The frame's text, for envelope classification.
    ///
    /// This matches the pre-`#3548` transport's `to_text` exactly, because the
    /// Relay routes on it: text is itself, binary/ping/pong payloads are
    /// interpreted as UTF-8, and a close frame is its reason. The Relay must not
    /// start classifying a different set of frames because the vocabulary type
    /// changed.
    pub fn to_text(&self) -> Result<&str, std::str::Utf8Error> {
        match self {
            Self::Text(text) => Ok(text),
            Self::Binary(data) | Self::Ping(data) | Self::Pong(data) => std::str::from_utf8(data),
            Self::Close(None) => Ok(""),
            Self::Close(Some(frame)) => Ok(&frame.reason),
        }
    }

    /// Adapter edge: adopt one inbound tungstenite frame.
    ///
    /// `None` is tungstenite's raw `Frame`, a write-side detail its readers
    /// never produce; a transport that cannot express this vocabulary says so
    /// rather than inventing a text or binary meaning for it.
    pub fn from_tungstenite(message: tokio_tungstenite::tungstenite::Message) -> Option<Self> {
        use tokio_tungstenite::tungstenite::Message as Wire;
        Some(match message {
            Wire::Text(text) => Self::Text(text),
            Wire::Binary(data) => Self::Binary(data),
            Wire::Ping(data) => Self::Ping(data),
            Wire::Pong(data) => Self::Pong(data),
            Wire::Close(frame) => Self::Close(frame.map(|frame| WsCloseFrame {
                code: u16::from(frame.code),
                reason: frame.reason.into_owned(),
            })),
            Wire::Frame(_) => return None,
        })
    }

    /// Adapter edge: hand this frame to a tungstenite sink.
    pub fn into_tungstenite(self) -> tokio_tungstenite::tungstenite::Message {
        use tokio_tungstenite::tungstenite::Message as Wire;
        match self {
            Self::Text(text) => Wire::Text(text),
            Self::Binary(data) => Wire::Binary(data),
            Self::Ping(data) => Wire::Ping(data),
            Self::Pong(data) => Wire::Pong(data),
            Self::Close(frame) => Wire::Close(frame.map(|frame| {
                tokio_tungstenite::tungstenite::protocol::CloseFrame {
                    code: frame.code.into(),
                    reason: frame.reason.into(),
                }
            })),
        }
    }
}

impl fmt::Display for WsFrame {
    /// A bounded, payload-free description: produced for log lines, never for
    /// the wire.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text(_) => f.write_str("text frame"),
            Self::Binary(_) => f.write_str("binary frame"),
            Self::Ping(_) => f.write_str("ping frame"),
            Self::Pong(_) => f.write_str("pong frame"),
            Self::Close(_) => f.write_str("close frame"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::Message as Wire;

    #[test]
    fn the_tungstenite_adapter_round_trips_every_frame() {
        for frame in [
            WsFrame::Text("hello".to_string()),
            WsFrame::Binary(vec![1, 2, 3]),
            WsFrame::Ping(vec![4]),
            WsFrame::Pong(vec![5]),
            WsFrame::Close(Some(WsCloseFrame {
                code: 1000,
                reason: "bye".to_string(),
            })),
            WsFrame::Close(None),
        ] {
            let wire = frame.clone().into_tungstenite();
            let back = WsFrame::from_tungstenite(wire).expect("no raw frame is produced here");
            assert_eq!(back, frame);
        }
    }

    #[test]
    fn a_raw_tungstenite_frame_has_no_transport_neutral_meaning() {
        let raw =
            Wire::Frame(tokio_tungstenite::tungstenite::protocol::frame::Frame::ping(Vec::new()));
        assert_eq!(WsFrame::from_tungstenite(raw), None);
    }

    #[test]
    fn the_budget_length_and_text_view_match_the_replaced_transport() {
        assert_eq!(WsFrame::Text("abc".to_string()).len(), 3);
        assert_eq!(WsFrame::Binary(vec![0; 4]).len(), 4);
        assert_eq!(WsFrame::Ping(vec![0; 2]).len(), 2);
        assert_eq!(
            WsFrame::Close(Some(WsCloseFrame {
                code: 1000,
                reason: "gone".to_string(),
            }))
            .len(),
            "gone".len()
        );
        assert_eq!(WsFrame::Close(None).len(), 0);

        assert_eq!(WsFrame::Text("body".to_string()).to_text(), Ok("body"));
        assert_eq!(WsFrame::Binary(b"json".to_vec()).to_text(), Ok("json"));
        assert_eq!(WsFrame::Ping(b"p".to_vec()).to_text(), Ok("p"));
        assert_eq!(WsFrame::Close(None).to_text(), Ok(""));
        assert_eq!(
            WsFrame::Close(Some(WsCloseFrame {
                code: 1001,
                reason: "reason".to_string(),
            }))
            .to_text(),
            Ok("reason")
        );
        assert!(WsFrame::Binary(vec![0xff, 0xfe]).to_text().is_err());
    }
}
