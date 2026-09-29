//! What of a captured pane is handed to a client, and why.
//!
//! The capture itself is [`TmuxOps::capture_pane`]'s; this module makes the two
//! decisions about its result on the way out. [`strip_trailing_blank_rows`]
//! drops the part of the screen the pane never wrote to, and [`bound`] applies a
//! byte ceiling to the tail, measured against the socket it will travel on.
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

use crate::tmux::ops::PaneModeFlags;

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

/// Drop the blank screen under the last row the session wrote to.
///
/// `capture-pane -p -S - -E -` ends at the bottom of the **visible pane**, not
/// at the last row anything was written to, and on a shell that has not filled
/// its screen those are different rows. Measured on a 41-row pane holding three
/// commands: 40 captured lines, **13 of them empty**, and the pane's own cursor
/// reported `cursor_y 27` — the row the last prompt sits on.
///
/// Every one of those empty rows was written into xterm anyway. The cursor ends
/// on the last of them, so the user gets their content at the top of a
/// mostly-empty screen with the caret far below it — 41 rows of screen geometry
/// presented as 41 rows of history.
///
/// **A row is blank when nothing on it would be visible** — no bytes, or only
/// whitespace and escape sequences. Measured, tmux emits a bare empty line
/// today; defining this as "zero bytes" would be a definition that stops being
/// the right one the first time a version pads instead of trimming, and it
/// would do it silently.
///
/// The last line's terminator goes with them. A terminal's cursor sits where the
/// application left it — after `root:~# `, not on the row below — and a stream
/// ending in a bare LF puts it on the next one, a row lower than the pane this
/// is mirroring.
pub fn strip_trailing_blank_rows(capture: &mut Vec<u8>) {
    // The index just past the last line that had something on it, its own
    // terminator excluded — so the stream ends on that line rather than below
    // it. A final line with no terminator at all is handled by the same pass.
    let mut keep = 0usize;
    let mut start = 0usize;
    for (i, byte) in capture.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        if let Some(line) = capture.get(start..i) {
            if !line_is_blank(line) {
                keep = i;
            }
        }
        start = i + 1;
    }
    // A final line the capture did not terminate. An empty one is blank by the
    // same rule as any other, so it needs no special case.
    if let Some(line) = capture.get(start..) {
        if !line_is_blank(line) {
            keep = capture.len();
        }
    }
    capture.truncate(keep);
}

/// Whether `line` would draw anything. Escape sequences are skipped whole, so a
/// row carrying only an SGR reset is still blank — see
/// [`strip_trailing_blank_rows`] for why the question is asked this way.
fn line_is_blank(line: &[u8]) -> bool {
    let mut rest = line;
    while let Some((&byte, tail)) = rest.split_first() {
        match byte {
            b' ' | b'\t' | b'\r' => rest = tail,
            0x1b => match tail.split_first() {
                // CSI: `ESC [`, then parameter and intermediate bytes, then a
                // final byte in `@`–`~`. Skipped whole, so a row carrying only
                // an SGR reset is still a row that draws nothing.
                Some((&b'[', after)) => {
                    rest = after
                        .iter()
                        .position(|b| (0x40..=0x7e).contains(b))
                        .and_then(|n| after.get(n + 1..))
                        .unwrap_or_default();
                }
                // A two-byte escape, e.g. `ESC =` or `ESC >`.
                Some((_, after)) => rest = after,
                // A trailing `ESC` with nothing after it.
                None => rest = tail,
            },
            _ => return false,
        }
    }
    true
}

/// A capture, turned into bytes a terminal can be *fed*.
///
/// **The capture's line separator is LF, and a terminal's is not.** Measured
/// against a live pane: `capture-pane -p` emits `41 41 41 0a` for a line `AAA`
/// — a bare newline. The live stream from the same pane carries `\r\n`, because
/// the tty's output post-processing (ONLCR) is upstream of tmux, and it is the
/// *grid* that loses it: a capture is a reconstruction of a screen, and a screen
/// has no carriage returns in it.
///
/// That difference is invisible until it is written into xterm with
/// `convertEol: false` — where LF moves down and leaves the cursor in the same
/// **column**, so every line starts where the previous one ended and the
/// history arrives as a diagonal. It was found in a screenshot rather than by a
/// test: the e2e assertions are about *content*, and the content was all there.
///
/// So the CR is restored here, which is the same act as [`mode_escapes`]: the
/// capture is a screen image, and this module is where a screen image becomes a
/// stream. An LF that already has a CR in front of it is left alone — tmux does
/// not emit one today, and a client that received `\r\r\n` would be no worse off
/// (a second CR at column 0 is a no-op), but a translation that doubles a
/// separator it was given is a translation that will eventually be wrong.
///
/// [`mode_escapes`]: self::mode_escapes
pub fn as_terminal_stream(capture: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(capture.len() + capture.len() / 40 + 16);
    let mut previous: Option<u8> = None;
    for &byte in capture {
        if byte == b'\n' && previous != Some(b'\r') {
            out.push(b'\r');
        }
        out.push(byte);
        previous = Some(byte);
    }
    out
}

/// The escapes that put a **fresh** terminal into the modes `flags` reports,
/// ready to be written ahead of a capture.
///
/// A capture restores the pane's *text*; this restores the *state* that text
/// was drawn in. Both are needed, and neither is the other: `capture-pane -e`
/// carries SGR attributes and never a private mode (measured — see
/// [`TmuxOps::pane_mode_flags`]).
///
/// # Ordering, and why `?1049` is not symmetric
///
/// The result goes **before** the capture bytes, so the escape for the
/// application's screen runs first and the capture lands on the screen it came
/// from. Sent the other way round, a TUI's text would be written to the normal
/// buffer and then hidden behind an empty alternate screen until the
/// application happened to redraw.
///
/// `?1049` is emitted only when it is **set**, and that asymmetry is
/// deliberate: entering the alternate screen is what the application's screen
/// requires, while leaving it is not a state a snapshot can assert — the client
/// this is written to has just been built and has no screen to leave. Every
/// other flag here is a level, so it is emitted in both directions, which also
/// means a mode that is *off* is stated rather than assumed.
///
/// # What is not here
///
/// **Bracketed paste (`?2004`) is not restored.** tmux exposes no format
/// variable for it — checked against 3.6b's own FORMATS list, which has the
/// flags this function reads and no others. An application that enabled it
/// before the client attached will not have it back until it re-asserts it.
/// Stated rather than left for someone to discover from a failing paste.
///
/// [`TmuxOps::pane_mode_flags`]: crate::tmux::ops::TmuxOps::pane_mode_flags
pub fn mode_escapes(flags: &PaneModeFlags) -> Vec<u8> {
    let mut out = Vec::new();
    // DEC private modes, each a level: `h` to set, `l` to clear.
    for (mode, on) in [
        (1u16, flags.keypad_cursor),
        (6, flags.origin),
        (7, flags.wrap),
        (25, flags.cursor_visible),
        (1000, flags.mouse_standard),
        (1002, flags.mouse_button),
        (1003, flags.mouse_all),
        (1006, flags.mouse_sgr),
        (1005, flags.mouse_utf8),
    ] {
        out.extend_from_slice(format!("\x1b[?{mode}{}", if on { 'h' } else { 'l' }).as_bytes());
    }
    if flags.alternate {
        // Set only — see the note on asymmetry above.
        out.extend_from_slice(b"\x1b[?1049h");
    }
    // IRM is not a private mode: `CSI 4 h`, with no `?`.
    out.extend_from_slice(if flags.insert { b"\x1b[4h" } else { b"\x1b[4l" });
    // DECKPAM / DECKPNM — a two-byte sequence, not a CSI at all.
    out.extend_from_slice(if flags.keypad { b"\x1b=" } else { b"\x1b>" });
    out
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

    /// Every mode off, except autowrap which tmux reports on by default.
    fn quiet_pane() -> PaneModeFlags {
        PaneModeFlags {
            wrap: true,
            cursor_visible: true,
            ..PaneModeFlags::default()
        }
    }

    #[test]
    fn every_line_gets_the_carriage_return_the_capture_cannot_express() {
        // The mutation this pins is deleting the translation: an LF-only
        // capture written into xterm with `convertEol: false` leaves the cursor
        // in the same column, so the history arrives as a diagonal — which is
        // how it was found, in a screenshot, with every content assertion green.
        assert_eq!(
            as_terminal_stream(b"one\ntwo\n"),
            b"one\r\ntwo\r\n".to_vec()
        );
    }

    #[test]
    fn an_lf_that_already_has_its_carriage_return_is_left_alone() {
        // Not because tmux emits one — it does not — but because a translation
        // that doubles a separator it was handed is one that will be wrong the
        // first time something upstream does.
        assert_eq!(
            as_terminal_stream(b"one\r\ntwo\r\n"),
            b"one\r\ntwo\r\n".to_vec()
        );
    }

    #[test]
    fn the_translation_does_not_touch_anything_else() {
        // The capture is a screen image with SGR attributes in it, and a
        // translation that rewrote bytes it did not understand would be a
        // capture corruptor. A bare CR, an ESC, and a non-ASCII octet all pass
        // through untouched.
        let input: &[u8] = b"\x1b[31mred\x1b[0m\rmid\n\xc3\xa9\n";
        assert_eq!(
            as_terminal_stream(input),
            b"\x1b[31mred\x1b[0m\rmid\r\n\xc3\xa9\r\n".to_vec()
        );
    }

    #[test]
    fn an_application_cursor_pane_is_restored_into_that_mode() {
        let flags = PaneModeFlags {
            keypad_cursor: true,
            ..quiet_pane()
        };
        let escapes = String::from_utf8(mode_escapes(&flags)).unwrap();
        assert!(
            escapes.contains("\x1b[?1h"),
            "criterion 13 is application cursor mode; without this the next \
             arrow key is `^[[A` while the application waits for `^[OA`: {escapes:?}"
        );
    }

    #[test]
    fn a_mode_that_is_off_is_cleared_rather_than_omitted() {
        let flags = PaneModeFlags {
            wrap: false,
            cursor_visible: false,
            ..PaneModeFlags::default()
        };
        let escapes = String::from_utf8(mode_escapes(&flags)).unwrap();
        // Both directions, because these are levels: a client that assumed a
        // default would be wrong for whichever default it assumed.
        assert!(escapes.contains("\x1b[?7l"), "{escapes:?}");
        assert!(escapes.contains("\x1b[?25l"), "{escapes:?}");
    }

    #[test]
    fn the_alternate_screen_is_entered_but_never_left() {
        let entered = String::from_utf8(mode_escapes(&PaneModeFlags {
            alternate: true,
            ..quiet_pane()
        }))
        .unwrap();
        assert!(entered.contains("\x1b[?1049h"), "{entered:?}");

        let not_entered = String::from_utf8(mode_escapes(&quiet_pane())).unwrap();
        assert!(
            !not_entered.contains("1049"),
            "a fresh client has no alternate screen to leave, and `?1049l` \
             would clear one it might already be on: {not_entered:?}"
        );
    }

    #[test]
    fn each_mouse_reporting_mode_is_restored_by_name() {
        // Not collapsed into "some mouse mode": 1000 reports presses, 1002 adds
        // drags and 1003 adds every move, and an application that asked for one
        // and got another has different gestures.
        let flags = PaneModeFlags {
            mouse_button: true,
            mouse_sgr: true,
            ..quiet_pane()
        };
        let escapes = String::from_utf8(mode_escapes(&flags)).unwrap();
        assert!(escapes.contains("\x1b[?1002h"), "{escapes:?}");
        assert!(escapes.contains("\x1b[?1006h"), "{escapes:?}");
        assert!(
            escapes.contains("\x1b[?1000l") && escapes.contains("\x1b[?1003l"),
            "the modes that are not set are cleared, not left to a default: {escapes:?}"
        );
    }

    #[test]
    fn the_two_non_private_modes_are_spelled_differently() {
        // IRM is `CSI 4 h` with no `?`, and DECKPAM is `ESC =`. Spelling either
        // as a private mode would set a mode the application never asked for.
        let escapes = String::from_utf8(mode_escapes(&PaneModeFlags {
            insert: true,
            keypad: true,
            ..quiet_pane()
        }))
        .unwrap();
        assert!(escapes.contains("\x1b[4h"), "{escapes:?}");
        assert!(!escapes.contains("\x1b[?4h"), "{escapes:?}");
        assert!(escapes.contains("\x1b="), "{escapes:?}");
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

    #[test]
    fn the_rows_the_pane_never_wrote_to_are_not_history() {
        // The shape measured on a live pane: a shell that had run three
        // commands on a 41-row screen, whose capture was 27 lines of content
        // followed by 13 empty ones. Every one of those empty rows was written
        // into xterm and the cursor landed on the last, so the user saw their
        // content at the top of a mostly-empty screen.
        let mut capture = b"root:~# echo hi\nhi\nroot:~# \n".to_vec();
        capture.extend(std::iter::repeat_n(b'\n', 13));
        strip_trailing_blank_rows(&mut capture);
        assert_eq!(
            capture,
            b"root:~# echo hi\nhi\nroot:~# ".to_vec(),
            "the stream has to end where the pane's cursor is — after the \
             prompt, not on the row below it"
        );
    }

    #[test]
    fn a_blank_row_between_two_written_ones_is_history() {
        // Only the trailing run is geometry. A gap the session printed is a gap
        // the user asked for, and dropping it would rewrite their output.
        let mut capture = b"one\n\ntwo\n\n\n".to_vec();
        strip_trailing_blank_rows(&mut capture);
        assert_eq!(capture, b"one\n\ntwo".to_vec());
    }

    #[test]
    fn a_row_that_would_draw_nothing_is_blank_however_it_is_spelled() {
        // tmux emits a bare empty line today — measured. Asking "is it zero
        // bytes" would be a question that quietly stops being the right one the
        // first time a version pads instead of trimming, so the row is judged
        // by what it would draw.
        let mut capture = b"text\n   \n\x1b[0m\n\x1b[m\t\n".to_vec();
        strip_trailing_blank_rows(&mut capture);
        assert_eq!(
            capture,
            b"text".to_vec(),
            "spaces and escapes draw nothing, so none of them are the last row"
        );
    }

    #[test]
    fn a_row_with_text_on_it_is_never_blank() {
        // The dangerous direction, and the one that would be silent: a parser
        // that over-consumed an escape could call a real row blank and truncate
        // the history without saying so. The prompt wears five escapes.
        let mut capture = b"\x1b[32mroot\x1b[39m:\x1b[34m~\x1b[39m# \n\n\n".to_vec();
        strip_trailing_blank_rows(&mut capture);
        assert_eq!(
            capture,
            b"\x1b[32mroot\x1b[39m:\x1b[34m~\x1b[39m# ".to_vec()
        );
    }

    #[test]
    fn a_capture_with_nothing_on_it_becomes_nothing() {
        let mut capture = vec![b'\n'; 41];
        strip_trailing_blank_rows(&mut capture);
        assert!(
            capture.is_empty(),
            "a screen nobody wrote to is not a history: {:?}",
            String::from_utf8_lossy(&capture)
        );
    }

    #[test]
    fn a_capture_that_already_ends_on_content_is_untouched() {
        // The function runs on every bootstrap, including one whose capture
        // already ends where it should. It has to be a no-op there.
        let mut capture = b"a\nb".to_vec();
        strip_trailing_blank_rows(&mut capture);
        assert_eq!(capture, b"a\nb".to_vec());
    }
}
