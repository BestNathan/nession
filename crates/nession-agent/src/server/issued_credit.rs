//! Bounded per-subscriber issued-output byte accounting for terminal P2 (#2030).
//!
//! This is NOT the Agent stream ring and NOT the outbound socket queue.
//! Only sequenced events actually handed to a subscriber's forwarder are
//! eligible for parser-applied credit. An authoritative resize costs zero PTY
//! bytes, but still occupies one required sequence ordinal.
//!
//! The caller must authenticate the peer, stream epoch, subscription, and
//! renderer generation BEFORE applying ACK credit. A checkpoint/attach cursor
//! is not proof of parsing; construction only establishes the ledger's local
//! starting ordinal. No capture may mint a trusted renderer baseline.

use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssuedCreditError {
    SequenceGap,
    CapacityExceeded,
    RegressiveAck,
    BeyondIssued,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IssuedEvent {
    seq: u64,
    bytes: usize,
}

/// A single subscriber's exact byte charges for its contiguous issued events.
///
/// `base_seq` is only a bookkeeping cut: the caller must separately prove
/// renderer continuity before relying on an ACK for actual flow control.
#[derive(Debug, Clone)]
pub struct IssuedByteCredit {
    issued_through: u64,
    credited_through: u64,
    outstanding_bytes: usize,
    max_events: usize,
    max_bytes: usize,
    pending: VecDeque<IssuedEvent>,
}

impl IssuedByteCredit {
    pub fn new(base_seq: u64, max_events: usize, max_bytes: usize) -> Self {
        Self {
            issued_through: base_seq,
            credited_through: base_seq,
            outstanding_bytes: 0,
            max_events,
            max_bytes,
            pending: VecDeque::new(),
        }
    }

    pub fn issued_through(&self) -> u64 {
        self.issued_through
    }

    pub fn credited_through(&self) -> u64 {
        self.credited_through
    }

    pub fn outstanding_bytes(&self) -> usize {
        self.outstanding_bytes
    }

    pub fn outstanding_events(&self) -> usize {
        self.pending.len()
    }

    /// Record one output or resize ordinal before offering its frame to the
    /// socket. If delivery fails, the subscription must be revoked, never
    /// credited as parsed. Reject gaps and oversize without mutating state.
    pub fn issue(&mut self, seq: u64, output_bytes: usize) -> Result<(), IssuedCreditError> {
        if self.issued_through.checked_add(1) != Some(seq) {
            return Err(IssuedCreditError::SequenceGap);
        }
        if self.pending.len() >= self.max_events
            || self
                .outstanding_bytes
                .checked_add(output_bytes)
                .is_none_or(|bytes| bytes > self.max_bytes)
        {
            return Err(IssuedCreditError::CapacityExceeded);
        }

        self.pending.push_back(IssuedEvent {
            seq,
            bytes: output_bytes,
        });
        self.outstanding_bytes += output_bytes;
        self.issued_through = seq;
        Ok(())
    }

    /// Release only whole, actually issued, contiguous event-prefix charges.
    /// The binding/renderer proof and appliedSeq provenance belong to the
    /// authenticated caller; neither the stream head nor a capture is proof.
    pub fn acknowledge(&mut self, through: u64) -> Result<usize, IssuedCreditError> {
        if through < self.credited_through {
            return Err(IssuedCreditError::RegressiveAck);
        }
        if through > self.issued_through {
            return Err(IssuedCreditError::BeyondIssued);
        }
        if through == self.credited_through {
            return Ok(0);
        }
        let mut released = 0usize;
        while let Some(event) = self.pending.pop_front() {
            if event.seq > through {
                self.pending.push_front(event);
                break;
            }
            released += event.bytes;
        }
        self.outstanding_bytes -= released;
        self.credited_through = through;
        Ok(released)
    }
}

/// Conservative bounded flow-control admission for a single authenticated
/// subscriber (#2030). Legacy subscribers without a parser-applied ACK remain
/// on the existing independently bounded outbound/queue policy.
#[derive(Debug, Clone)]
pub struct SubscriberIssuedFlow {
    epoch: Option<u64>,
    last_issued: Option<u64>,
    credit: Option<IssuedByteCredit>,
}

impl SubscriberIssuedFlow {
    const MAX_UNACKED_EVENTS: usize = 1024;
    const MAX_UNACKED_BYTES: usize = 2 * 1024 * 1024;

    pub fn new() -> Self {
        Self {
            epoch: None,
            last_issued: None,
            credit: None,
        }
    }

    /// A flow whose subscription starts at an Agent stream cut (#2877).
    ///
    /// The cut is what the attach reply / bootstrap proved, not a parser
    /// position. It is the **lower bound** of what this subscriber may claim
    /// as applied: a renderer preserved across a re-attach legitimately holds
    /// a prefix at or below it, and treating that prefix as "ahead of what we
    /// issued" would invent an inconsistency on every healthy reattach. New
    /// events issued after the cut remain the strict upper bound.
    pub fn new_with_base(base: u64) -> Self {
        Self {
            epoch: None,
            last_issued: Some(base),
            credit: None,
        }
    }

    /// The highest sequence this subscriber has actually been issued.
    ///
    /// This is the authoritative frontier for a progress report: the
    /// session-global head is not evidence that this subscriber was handed
    /// those events. `base` (the attach cut) is a conservative floor.
    pub fn issued_frontier(&self) -> u64 {
        let issued = self
            .credit
            .as_ref()
            .map_or(0, IssuedByteCredit::issued_through);
        issued.max(self.last_issued.unwrap_or(0))
    }

    /// Called immediately BEFORE offering an event to the serialized
    /// outbound writer. Dequeue is *not* the acknowledgement of this event.
    /// Failed sends revoke this subscriber, never credit undelivered output.
    pub fn issue(&mut self, epoch: u64, seq: u64, bytes: usize) -> Result<(), IssuedCreditError> {
        if epoch == 0 || seq == 0 {
            return if self.credit.is_some() {
                Err(IssuedCreditError::SequenceGap)
            } else {
                Ok(())
            };
        }
        if let Some(ledger) = &mut self.credit {
            if self.epoch != Some(epoch) {
                return Err(IssuedCreditError::SequenceGap);
            }
            ledger.issue(seq, bytes)?;
        }
        // The opt-in boundary may be an arbitrary Agent stream cut, and
        // legacy output has no issued-ledger continuity obligation.
        self.epoch = Some(epoch);
        self.last_issued = Some(seq);
        Ok(())
    }

    /// Only the already authenticated, renderer-fenced, advancing ACK may
    /// activate or release credit. The first advancing parser ACK merely
    /// creates a conservative cut at the *last issued* ordinal: it never
    /// retroactively credits bytes issued before the opt-in baseline.
    ///
    /// It must not be used with an unverified attach cursor or transport
    /// delivery receipt. Replay outside this live lane does not mint credit.
    pub fn parser_ack(
        &mut self,
        epoch: u64,
        parsed_through: u64,
    ) -> Result<usize, IssuedCreditError> {
        if self.epoch != Some(epoch) || parsed_through == 0 {
            return Ok(0);
        }
        let Some(last_issued) = self.last_issued else {
            return Ok(0);
        };
        match &mut self.credit {
            Some(ledger) => {
                // Old parser callbacks may precede the opt-in cut. They must
                // not free later bytes or regress the credit cursor.
                if parsed_through < ledger.credited_through() {
                    return Ok(0);
                }
                ledger.acknowledge(parsed_through)
            }
            None => {
                if parsed_through <= last_issued {
                    self.credit = Some(IssuedByteCredit::new(
                        last_issued,
                        Self::MAX_UNACKED_EVENTS,
                        Self::MAX_UNACKED_BYTES,
                    ));
                }
                Ok(0)
            }
        }
    }

    pub fn outstanding_bytes(&self) -> usize {
        self.credit
            .as_ref()
            .map_or(0, IssuedByteCredit::outstanding_bytes)
    }

    pub fn last_issued(&self) -> Option<u64> {
        self.last_issued
    }

    pub fn credit_enabled(&self) -> bool {
        self.credit.is_some()
    }
}

impl Default for SubscriberIssuedFlow {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscription_frontier_starts_at_the_attach_cut_and_tracks_only_its_own_issues() {
        // A preserved renderer may hold a prefix at or below the cut it joined;
        // a fresh subscriber was issued nothing above it.
        let mut flow = SubscriberIssuedFlow::new_with_base(7);
        assert_eq!(flow.issued_frontier(), 7);
        flow.issue(3, 8, 2).unwrap();
        assert_eq!(flow.issued_frontier(), 8);
        // The first parser ACK only opts into credit at the last issued
        // ordinal; it does not move the frontier.
        assert_eq!(flow.parser_ack(3, 8), Ok(0));
        assert!(flow.credit_enabled());
        assert_eq!(flow.issued_frontier(), 8);
        flow.issue(3, 9, 2).unwrap();
        assert_eq!(flow.issued_frontier(), 9);
        assert_eq!(flow.parser_ack(3, 9), Ok(2));
        assert_eq!(
            flow.issued_frontier(),
            9,
            "acknowledgement moves credit, not the frontier"
        );

        // Another subscriber on the same session never inherits this one's
        // issued position.
        let other = SubscriberIssuedFlow::new_with_base(0);
        assert_eq!(other.issued_frontier(), 0);
    }

    #[test]
    fn output_resize_output_releases_only_the_applied_prefix() {
        let mut credit = IssuedByteCredit::new(40, 3, 12);
        credit.issue(41, 5).unwrap();
        credit.issue(42, 0).unwrap(); // Authoritative resize consumes a seq.
        credit.issue(43, 7).unwrap();
        assert_eq!(credit.outstanding_events(), 3);
        assert_eq!(credit.outstanding_bytes(), 12);
        assert_eq!(credit.acknowledge(42), Ok(5));
        assert_eq!(credit.credited_through(), 42);
        assert_eq!(credit.outstanding_events(), 1);
        assert_eq!(credit.outstanding_bytes(), 7);
        assert_eq!(credit.acknowledge(42), Ok(0));
        assert_eq!(credit.acknowledge(43), Ok(7));
        assert_eq!(credit.outstanding_events(), 0);
        assert_eq!(credit.outstanding_bytes(), 0);
    }

    #[test]
    fn rejected_future_regressive_and_gap_do_not_mutate_credit() {
        let mut credit = IssuedByteCredit::new(10, 4, 20);
        assert_eq!(credit.issue(12, 3), Err(IssuedCreditError::SequenceGap));
        assert_eq!(credit.acknowledge(11), Err(IssuedCreditError::BeyondIssued));
        credit.issue(11, 6).unwrap();
        assert_eq!(credit.acknowledge(12), Err(IssuedCreditError::BeyondIssued));
        assert_eq!(credit.outstanding_bytes(), 6);
        assert_eq!(credit.acknowledge(11), Ok(6));
        assert_eq!(
            credit.acknowledge(10),
            Err(IssuedCreditError::RegressiveAck)
        );
        assert_eq!(credit.outstanding_bytes(), 0);
        assert_eq!(credit.credited_through(), 11);
    }

    #[test]
    fn byte_event_and_oversized_limits_do_not_silently_evict() {
        let mut credit = IssuedByteCredit::new(0, 2, 10);
        assert_eq!(
            credit.issue(1, 11),
            Err(IssuedCreditError::CapacityExceeded)
        );
        assert_eq!(credit.issued_through(), 0);
        credit.issue(1, 6).unwrap();
        assert_eq!(credit.issue(2, 5), Err(IssuedCreditError::CapacityExceeded));
        credit.issue(2, 4).unwrap();
        assert_eq!(credit.issue(3, 0), Err(IssuedCreditError::CapacityExceeded));
        assert_eq!(credit.outstanding_bytes(), 10);
        assert_eq!(credit.issued_through(), 2);
        assert_eq!(credit.acknowledge(1), Ok(6));
        credit.issue(3, 4).unwrap();
        assert_eq!(credit.outstanding_bytes(), 8);
    }

    #[test]
    fn one_stalled_subscriber_cannot_consume_anothers_credit() {
        let mut slow = IssuedByteCredit::new(5, 2, 8);
        let mut healthy = IssuedByteCredit::new(5, 2, 8);
        for ledger in [&mut slow, &mut healthy] {
            ledger.issue(6, 8).unwrap();
        }
        assert_eq!(slow.issue(7, 1), Err(IssuedCreditError::CapacityExceeded));
        assert_eq!(healthy.acknowledge(6), Ok(8));
        assert_eq!(healthy.issue(7, 1), Ok(()));
        assert_eq!(healthy.outstanding_bytes(), 1);
        assert_eq!(slow.outstanding_bytes(), 8);
    }

    #[test]
    fn live_credit_opt_in_does_not_acknowledge_prebaseline_or_dequeue() {
        let mut flow = SubscriberIssuedFlow::new();
        flow.issue(7, 41, 11).unwrap();
        assert_eq!(flow.outstanding_bytes(), 0);
        assert!(!flow.credit_enabled());
        // Simulates a genuine parser ACK, not an outbound queue receipt.
        assert_eq!(flow.parser_ack(7, 41), Ok(0));
        assert!(flow.credit_enabled());
        flow.issue(7, 42, 5).unwrap();
        flow.issue(7, 43, 0).unwrap();
        flow.issue(7, 44, 7).unwrap();
        assert_eq!(flow.outstanding_bytes(), 12);
        assert_eq!(flow.parser_ack(7, 42), Ok(5));
        assert_eq!(flow.outstanding_bytes(), 7);
        assert_eq!(flow.parser_ack(7, 44), Ok(7));
        assert_eq!(flow.outstanding_bytes(), 0);
    }

    #[test]
    fn forged_future_ack_and_epoch_cannot_release_live_credit() {
        let mut flow = SubscriberIssuedFlow::new();
        flow.issue(17, 1, 8).unwrap();
        flow.parser_ack(17, 1).unwrap();
        flow.issue(17, 2, 6).unwrap();
        assert_eq!(flow.parser_ack(18, 2), Ok(0));
        assert_eq!(flow.parser_ack(17, 3), Err(IssuedCreditError::BeyondIssued));
        assert_eq!(flow.outstanding_bytes(), 6);
        assert_eq!(flow.parser_ack(17, 2), Ok(6));
        assert_eq!(flow.issue(18, 3, 1), Err(IssuedCreditError::SequenceGap));
    }

    #[test]
    fn legacy_slow_peer_is_independent_and_never_opted_in_by_transport_dequeue() {
        let mut slow = SubscriberIssuedFlow::new();
        let mut fast = SubscriberIssuedFlow::new();
        for peer in [&mut slow, &mut fast] {
            peer.issue(7, 1, 1).unwrap();
        }
        fast.parser_ack(7, 1).unwrap();
        for seq in 2..=1026 {
            slow.issue(7, seq, 4096).unwrap();
            // Legacy policy remains the existing independent bounded queues.
            if seq <= 1025 {
                fast.issue(7, seq, 1).unwrap();
            }
        }
        assert!(!slow.credit_enabled());
        assert_eq!(slow.outstanding_bytes(), 0);
        assert_eq!(
            fast.issue(7, 1026, 1),
            Err(IssuedCreditError::CapacityExceeded)
        );
        assert_eq!(fast.last_issued(), Some(1025));
        assert_eq!(fast.outstanding_bytes(), 1024);
    }

    #[test]
    fn restart_creates_an_independent_ledger_not_a_carry_over() {
        let mut old = IssuedByteCredit::new(50, 3, 20);
        old.issue(51, 10).unwrap();
        let mut restarted = IssuedByteCredit::new(0, 3, 20);
        assert_eq!(
            restarted.acknowledge(51),
            Err(IssuedCreditError::BeyondIssued)
        );
        restarted.issue(1, 3).unwrap();
        assert_eq!(restarted.acknowledge(1), Ok(3));
        assert_eq!(old.outstanding_bytes(), 10);
    }
}
