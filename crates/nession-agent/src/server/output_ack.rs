//! Fail-closed per-subscriber Output Applied ACK state (#1993, #1645).
//!
//! This is a *verdict* over a claimed parser-applied prefix, NOT proof that
//! xterm parsed the bytes. Only a future authenticated protocol handler may
//! feed it ACKs from a verified renderer/subscription binding. A successful
//! verdict never releases queue bytes or asserts snapshot cut consistency.
//!
//! Input ACK (#1307) is an independent Agent->client PTY-write cursor and
//! must never share this state or wire identity.

/// Highest JSON integer that JavaScript can round-trip losslessly.
const MAX_SAFE_WIRE_INTEGER: u64 = (1_u64 << 53) - 1;

/// The identity is server-owned and scoped to a single attached subscriber.
/// Reusing a client id is *not* reusing this generation: a new attach must
/// provide a new token, even when the underlying tmux session is unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputAckBinding {
    pub subscriber_generation: u64,
    pub stream_epoch: u64,
}

/// A no-credit verdict. Even `Advanced` is only eligible for bookkeeping;
/// translating its delta to byte credit needs independent per-event accounting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputAckVerdict {
    Advanced { previous: u64, applied_through: u64 },
    Duplicate,
    StaleSubscriber,
    StaleEpoch,
    StaleRenderer,
    Regressive,
    BeyondIssuedHead,
    UnsafeWireInteger,
}

/// The server-side cursor of **one** subscription/stream identity.
///
/// No connection- or session-global ACK: one slow Observer must never be able
/// to advance a healthy peer's cursor, and a prior attach must never be able
/// to acknowledge output delivered to a replacement subscriber.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriberOutputAck {
    binding: OutputAckBinding,
    applied_through: u64,
    /// Renderer identity is pinned by the first advancing parser ACK. A
    /// remount must reattach rather than reuse this subscriber generation.
    renderer_generation: Option<u64>,
}

fn is_safe_positive(value: u64) -> bool {
    (1..=MAX_SAFE_WIRE_INTEGER).contains(&value)
}

impl SubscriberOutputAck {
    /// Only the Agent-side attach path may construct a binding. Reject zero
    /// and unsafe generations/epochs rather than serializing identities that
    /// a browser cannot echo exactly.
    pub fn new(binding: OutputAckBinding) -> Result<Self, OutputAckVerdict> {
        if !is_safe_positive(binding.subscriber_generation)
            || !is_safe_positive(binding.stream_epoch)
        {
            return Err(OutputAckVerdict::UnsafeWireInteger);
        }
        Ok(Self {
            binding,
            applied_through: 0,
            renderer_generation: None,
        })
    }

    pub fn binding(&self) -> OutputAckBinding {
        self.binding
    }

    pub fn applied_through(&self) -> u64 {
        self.applied_through
    }

    /// The first *advancing* ACK pins the renderer that parsed the bytes.
    /// An old callback cannot advance this subscription after the client
    /// switches its renderer while reusing a transport. Binding must be
    /// renewed with a new subscriber generation after a renderer remount.
    /// This fences identity only: it does not establish a verified checkpoint
    /// baseline or release any output byte credit (#2030).
    pub fn observe_with_renderer(
        &mut self,
        claimed: OutputAckBinding,
        renderer_generation: u64,
        applied_through: u64,
        issued_head: u64,
    ) -> OutputAckVerdict {
        if claimed.subscriber_generation != self.binding.subscriber_generation {
            return OutputAckVerdict::StaleSubscriber;
        }
        if claimed.stream_epoch != self.binding.stream_epoch {
            return OutputAckVerdict::StaleEpoch;
        }
        if !is_safe_positive(renderer_generation) {
            return OutputAckVerdict::UnsafeWireInteger;
        }
        if self
            .renderer_generation
            .is_some_and(|pinned| pinned != renderer_generation)
        {
            return OutputAckVerdict::StaleRenderer;
        }
        let verdict = self.observe(claimed, applied_through, issued_head);
        if matches!(verdict, OutputAckVerdict::Advanced { .. }) {
            self.renderer_generation = Some(renderer_generation);
        }
        verdict
    }

    /// An Agent-authorized reattach/restart revokes the prior binding.
    /// Resetting the *same* identity is forbidden: that would permit
    /// duplicate/reordered ACKs to rewind the acknowledged prefix.
    pub fn replace(&mut self, next: OutputAckBinding) -> Result<(), OutputAckVerdict> {
        let replacement = Self::new(next)?;
        if next == self.binding {
            return Err(OutputAckVerdict::Duplicate);
        }
        *self = replacement;
        Ok(())
    }

    /// Validate a cumulative ACK against the live Agent stream head.
    ///
    /// `issued_head` comes from the Agent's session stream, NOT the client.
    /// A fresh state starts at zero, and acknowledging zero is a duplicate.
    /// None of the rejected paths mutates progress. The enclosing transport
    /// handler must additionally authenticate the connection as this peer.
    pub fn observe(
        &mut self,
        claimed: OutputAckBinding,
        applied_through: u64,
        issued_head: u64,
    ) -> OutputAckVerdict {
        if claimed.subscriber_generation != self.binding.subscriber_generation {
            return OutputAckVerdict::StaleSubscriber;
        }
        if claimed.stream_epoch != self.binding.stream_epoch {
            return OutputAckVerdict::StaleEpoch;
        }
        if !is_safe_positive(claimed.subscriber_generation)
            || !is_safe_positive(claimed.stream_epoch)
            || applied_through > MAX_SAFE_WIRE_INTEGER
            || issued_head > MAX_SAFE_WIRE_INTEGER
        {
            return OutputAckVerdict::UnsafeWireInteger;
        }
        if applied_through < self.applied_through {
            return OutputAckVerdict::Regressive;
        }
        if applied_through > issued_head {
            return OutputAckVerdict::BeyondIssuedHead;
        }
        if applied_through == self.applied_through {
            return OutputAckVerdict::Duplicate;
        }
        let previous = self.applied_through;
        self.applied_through = applied_through;
        OutputAckVerdict::Advanced {
            previous,
            applied_through,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(generation: u64, epoch: u64) -> OutputAckBinding {
        OutputAckBinding {
            subscriber_generation: generation,
            stream_epoch: epoch,
        }
    }

    #[test]
    fn cumulative_ack_advances_only_when_within_issued_stream_head() {
        let id = binding(11, 37);
        let mut a = SubscriberOutputAck::new(id).unwrap();
        let mut b = SubscriberOutputAck::new(binding(12, 37)).unwrap();
        assert_eq!(a.observe(id, 0, 0), OutputAckVerdict::Duplicate);
        assert_eq!(
            a.observe(id, 1, 3),
            OutputAckVerdict::Advanced {
                previous: 0,
                applied_through: 1,
            }
        );
        assert_eq!(
            a.observe(id, 3, 3),
            OutputAckVerdict::Advanced {
                previous: 1,
                applied_through: 3,
            }
        );
        assert_eq!(a.observe(id, 3, 3), OutputAckVerdict::Duplicate);
        assert_eq!(a.applied_through(), 3);
        assert_eq!(b.applied_through(), 0);
        assert_eq!(b.observe(id, 3, 3), OutputAckVerdict::StaleSubscriber);
        assert_eq!(b.applied_through(), 0);
    }

    #[test]
    fn invalid_and_out_of_order_claims_cannot_move_cursor() {
        let id = binding(13, 39);
        let mut a = SubscriberOutputAck::new(id).unwrap();
        assert_eq!(a.observe(id, 4, 3), OutputAckVerdict::BeyondIssuedHead);
        assert_eq!(
            a.observe(binding(99, 39), 2, 3),
            OutputAckVerdict::StaleSubscriber
        );
        assert_eq!(
            a.observe(binding(13, 40), 2, 3),
            OutputAckVerdict::StaleEpoch
        );
        assert_eq!(
            a.observe(id, u64::MAX, 3),
            OutputAckVerdict::UnsafeWireInteger
        );
        assert_eq!(
            a.observe(id, 1, u64::MAX),
            OutputAckVerdict::UnsafeWireInteger
        );
        assert_eq!(a.applied_through(), 0);
        assert!(matches!(
            a.observe(id, 2, 3),
            OutputAckVerdict::Advanced { .. }
        ));
        assert_eq!(a.observe(id, 1, 3), OutputAckVerdict::Regressive);
        assert_eq!(a.observe(id, 3, 2), OutputAckVerdict::BeyondIssuedHead);
        assert_eq!(a.applied_through(), 2);
    }

    #[test]
    fn replacement_and_epoch_change_revoke_old_ack_provenance() {
        let old = binding(15, 41);
        let new_peer = binding(16, 41);
        let new_epoch = binding(16, 42);
        let mut cursor = SubscriberOutputAck::new(old).unwrap();
        assert!(matches!(
            cursor.observe(old, 3, 3),
            OutputAckVerdict::Advanced { .. }
        ));
        assert_eq!(cursor.replace(old), Err(OutputAckVerdict::Duplicate));
        assert_eq!(cursor.applied_through(), 3);
        cursor.replace(new_peer).unwrap();
        assert_eq!(cursor.applied_through(), 0);
        assert_eq!(cursor.observe(old, 4, 4), OutputAckVerdict::StaleSubscriber);
        cursor.replace(new_epoch).unwrap();
        assert_eq!(cursor.observe(new_peer, 4, 4), OutputAckVerdict::StaleEpoch);
        assert_eq!(
            cursor.observe(new_epoch, 1, 1),
            OutputAckVerdict::Advanced {
                previous: 0,
                applied_through: 1,
            }
        );
    }

    #[test]
    fn renderer_is_pinned_only_by_advancing_ack_and_reset_on_reattach() {
        let first = binding(21, 43);
        let next = binding(22, 43);
        let mut cursor = SubscriberOutputAck::new(first).unwrap();

        // A speculative or rejected ACK cannot choose the renderer identity.
        assert_eq!(
            cursor.observe_with_renderer(first, 7, 5, 4),
            OutputAckVerdict::BeyondIssuedHead
        );
        assert_eq!(
            cursor.observe_with_renderer(first, 0, 0, 4),
            OutputAckVerdict::UnsafeWireInteger
        );
        assert_eq!(
            cursor.observe_with_renderer(first, 8, 0, 4),
            OutputAckVerdict::Duplicate
        );
        assert_eq!(
            cursor.observe_with_renderer(first, 9, 2, 4),
            OutputAckVerdict::Advanced {
                previous: 0,
                applied_through: 2,
            }
        );
        assert_eq!(
            cursor.observe_with_renderer(first, 8, 3, 4),
            OutputAckVerdict::StaleRenderer
        );
        assert_eq!(cursor.applied_through(), 2);
        assert_eq!(
            cursor.observe_with_renderer(first, 9, 3, 4),
            OutputAckVerdict::Advanced {
                previous: 2,
                applied_through: 3,
            }
        );

        // Renewing subscriber identity is required after renderer remount.
        cursor.replace(next).unwrap();
        assert_eq!(cursor.applied_through(), 0);
        assert_eq!(
            cursor.observe_with_renderer(first, 9, 1, 4),
            OutputAckVerdict::StaleSubscriber
        );
        assert_eq!(
            cursor.observe_with_renderer(next, 10, 1, 4),
            OutputAckVerdict::Advanced {
                previous: 0,
                applied_through: 1,
            }
        );
        assert_eq!(
            cursor.observe_with_renderer(next, 9, 2, 4),
            OutputAckVerdict::StaleRenderer
        );
        assert_eq!(cursor.applied_through(), 1);
    }

    #[test]
    fn reject_non_roundtrippable_wire_identity_without_dropping_old_binding() {
        assert_eq!(
            SubscriberOutputAck::new(binding(0, 7)),
            Err(OutputAckVerdict::UnsafeWireInteger)
        );
        assert_eq!(
            SubscriberOutputAck::new(binding(7, 0)),
            Err(OutputAckVerdict::UnsafeWireInteger)
        );
        assert_eq!(
            SubscriberOutputAck::new(binding(MAX_SAFE_WIRE_INTEGER + 1, 7)),
            Err(OutputAckVerdict::UnsafeWireInteger)
        );
        let old = binding(1, 2);
        let mut cursor = SubscriberOutputAck::new(old).unwrap();
        assert_eq!(
            cursor.replace(binding(3, u64::MAX)),
            Err(OutputAckVerdict::UnsafeWireInteger)
        );
        assert_eq!(cursor.binding(), old);
        assert_eq!(cursor.applied_through(), 0);
    }
}
