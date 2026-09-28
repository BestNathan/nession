//! How much of a captured pane is handed to a client, and why that number.
//!
//! The capture itself is [`TmuxOps::capture_pane`]'s; this module is the one
//! decision made about its result on the way out — a byte ceiling, applied to
//! the tail, measured against the socket it will travel on.
//!
//! # Why a byte ceiling and not a line count
//!
//! [`HISTORY_LIMIT_LINES`] sounds like the bound and is not. It is a *line*
//! count, and the bytes per line are not knowable from it: `capture-pane -e`
//! re-emits the attributes on every line, so a build log or a diff can be an
//! order of magnitude heavier per line than a shell prompt. #321 says so in its
//! own words — "ANSI-heavy / very wide output 的 wire size 可能远高于简单
//! line-count 估算". A bound that a caller can be surprised by is not a bound.
//!
//! # Why this ceiling, and no chunking
//!
//! The owner's estimate when the depth was fixed at 5000 lines was **~0.4 MB**
//! for a typical capture (#321, 2026-08-20). The ceiling is set above that, so
//! an ordinary session is not truncated at all, and far below the frame it has
//! to fit in.
//!
//! Chunking was designed and then dropped, because the ceiling removes the
//! problem it existed for. Against `OUTBOUND_BYTE_BUDGET` (4 MiB) a capped
//! capture is ~683 KiB once base64 has inflated it by a third — one frame, a
//! sixth of the budget, and `charge` in `nession-runtime` clamps rather than
//! refuses, so it cannot evict the budget even if it were larger. The stall
//! policy is satisfied for the same reason: 683 KiB across
//! `DEFAULT_TERMINAL_STALL_GRACE` (15 s) implies ~45 KiB/s, comfortably above
//! the ~23 KiB/s floor that policy's own doc calls "not slow, gone". A chunked
//! protocol would buy nothing and cost a `chunk_index`/`final_chunk` pair on the
//! wire, a reassembly path in the browser, and a partial-bootstrap failure mode
//! that does not otherwise exist.
//!
//! [`TmuxOps::capture_pane`]: crate::tmux::ops::TmuxOps::capture_pane
//! [`HISTORY_LIMIT_LINES`]: crate::tmux::HISTORY_LIMIT_LINES

/// The most raw capture bytes a client is handed.
///
/// Above the ~0.4 MB a typical 5000-line capture measures, below anything the
/// outbound budget or the terminal stall policy would notice — see the module
/// docs for that arithmetic.
pub const BOOTSTRAP_MAX_BYTES: usize = 512 * 1024;

/// A capture reduced to what will actually be sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bounded {
    /// The bytes to send: the tail of the capture, never longer than
    /// [`BOOTSTRAP_MAX_BYTES`].
    pub bytes: Vec<u8>,
    /// Whether the ceiling cut something. **Observable, not silent** — a client
    /// that received a truncated history and one that received all of it are
    /// different states, and only one of them should read as "this is the
    /// history".
    pub truncated: bool,
}

/// Keep the last [`BOOTSTRAP_MAX_BYTES`] of `capture`, starting at a line
/// boundary.
///
/// The **tail**, because a client attaching to a live session wants what just
/// happened; dropping from the front is what makes this a recent-context
/// snapshot rather than an arbitrary one.
///
/// Line alignment is a preference, not a correctness property — `terminal.write`
/// is ordered, so a split inside an escape sequence still renders — but it
/// makes the truncated capture meaningful to a human reading a trace, and it
/// keeps the reassembly test simple. When the kept window has no newline at all
/// (one enormous line), the cut stays where the ceiling put it rather than
/// discarding everything.
#[must_use]
pub fn bound(mut capture: Vec<u8>) -> Bounded {
    if capture.len() <= BOOTSTRAP_MAX_BYTES {
        return Bounded {
            bytes: capture,
            truncated: false,
        };
    }
    // Dropped by `drain` rather than sliced, so the two moves are the buffer's
    // own and neither can be out of range: the first takes exactly the excess
    // the ceiling named, the second runs to a newline that was just found in
    // the buffer it is draining.
    capture.drain(..capture.len() - BOOTSTRAP_MAX_BYTES);
    if let Some(first_newline) = capture.iter().position(|b| *b == b'\n') {
        capture.drain(..=first_newline);
    }
    Bounded {
        bytes: capture,
        truncated: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::outbound::OUTBOUND_BYTE_BUDGET;

    /// A capture of `lines` newline-terminated lines, `payload` bytes each.
    fn capture_of(lines: usize, payload: usize) -> Vec<u8> {
        let mut out = Vec::new();
        for i in 0..lines {
            out.extend(format!("{i:06}").into_bytes());
            out.extend(std::iter::repeat_n(b'x', payload.saturating_sub(6)));
            out.push(b'\n');
        }
        out
    }

    #[test]
    fn a_capture_under_the_ceiling_is_untouched() {
        let capture = capture_of(100, 40);
        let bounded = bound(capture.clone());
        assert_eq!(bounded.bytes, capture);
        assert!(!bounded.truncated, "nothing was cut, so say so");
    }

    #[test]
    fn a_capture_over_the_ceiling_keeps_its_tail() {
        let capture = capture_of(20_000, 60); // ~1.2 MB, well over the ceiling
        let bounded = bound(capture.clone());
        assert!(bounded.truncated);
        assert!(bounded.bytes.len() <= BOOTSTRAP_MAX_BYTES);
        assert!(
            capture.ends_with(&bounded.bytes),
            "the tail is what a client attaching to a live session wants"
        );
        assert!(
            !capture.starts_with(&bounded.bytes),
            "and it is not the head — this is the mutation that makes the test \
             about the direction of the cut"
        );
    }

    #[test]
    fn the_kept_window_starts_on_a_line_boundary() {
        // Every line in this fixture is exactly `LINE` bytes plus its newline,
        // so "the first line is whole" is a position, not a judgement call: the
        // first newline in the kept window sits at the end of a full line.
        const LINE: usize = 60;
        let capture = capture_of(20_000, LINE);
        let bounded = bound(capture);
        assert_eq!(
            bounded.bytes.iter().position(|b| *b == b'\n'),
            Some(LINE),
            "the window opens mid-line, so its first line is the back half of \
             one: {:?}",
            String::from_utf8_lossy(&bounded.bytes[..LINE])
        );
    }

    #[test]
    fn a_single_enormous_line_is_still_bounded() {
        // No newline anywhere in the kept window: the cut stays at the ceiling
        // rather than throwing the whole capture away.
        let capture = vec![b'x'; BOOTSTRAP_MAX_BYTES * 2];
        let bounded = bound(capture);
        assert!(bounded.truncated);
        assert_eq!(bounded.bytes.len(), BOOTSTRAP_MAX_BYTES);
    }

    #[test]
    fn a_capped_capture_fits_the_frame_it_travels_in() {
        // The arithmetic the module docs claim, asserted rather than asserted-to
        // in prose. Base64 inflates by 4/3; the socket's budget is the frame's
        // limit. Lowering the budget or raising the ceiling reddens this, which
        // is the point — the two numbers are one decision.
        let worst_case = BOOTSTRAP_MAX_BYTES.div_ceil(3) * 4;
        assert!(
            worst_case < OUTBOUND_BYTE_BUDGET,
            "a capped bootstrap base64s to {worst_case} bytes against a \
             {OUTBOUND_BYTE_BUDGET}-byte budget; the ceiling is no longer a \
             ceiling"
        );
    }

    #[test]
    fn an_ordinary_full_history_is_not_truncated() {
        // The owner's estimate when the depth was fixed at 5000 lines was
        // ~0.4 MB, and a ceiling below that would truncate exactly the sessions
        // the depth was chosen for. Asserted as behaviour against a capture of
        // that size rather than as a comparison between two constants — the
        // question is what the function does, not what the numbers look like.
        let typical = capture_of(5_000, 81);
        assert!(
            typical.len() > 400 * 1024,
            "the fixture should be a realistic full history: {} bytes",
            typical.len()
        );
        let bounded = bound(typical.clone());
        assert!(
            !bounded.truncated,
            "a full 5000-line history was cut at {} bytes",
            typical.len()
        );
        assert_eq!(bounded.bytes, typical);
    }
}
