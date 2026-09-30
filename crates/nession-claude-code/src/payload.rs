//! Bounding a canonical payload for a wire, shared by both projections (#1234).
//!
//! The canonical layer reports what a transcript says, at whatever size it says
//! it; how much of that may travel is a property of each *contract*. Both
//! projections answer that question the same way, so the arithmetic lives here
//! rather than in two copies — measured, the largest attachment record is 1.2 MB
//! against a 128 KiB page budget, so a page-level bound is doing real work and
//! two versions of it could disagree about what a page is allowed to carry.

use crate::canonical::Payload;
use crate::protocol::messages::v1::{PayloadKindV1, PayloadV1};

/// Cut one payload to what the page can still afford.
///
/// **The body is always present, even at zero budget** — emptied and marked
/// truncated rather than dropped. Dropping it would make "this response could
/// not carry it" indistinguishable from "the transcript did not record it",
/// which are the two things `skip_serializing_if` on the field is there to tell
/// apart.
pub(crate) fn spend(budget: &mut usize, payload: &Payload, ceiling: usize) -> PayloadV1 {
    let allowed = ceiling.min(*budget);
    let (text, cut) = truncate_bytes(&payload.text, allowed);
    *budget = budget.saturating_sub(text.len());
    PayloadV1 {
        text,
        kind: if payload.is_json {
            PayloadKindV1::Json
        } else {
            PayloadKindV1::Text
        },
        truncated: payload.truncated || cut,
    }
}

/// Cut `s` to at most `max` **bytes**, on a character boundary.
///
/// Bytes rather than characters because the ceilings are about how much travels
/// on the wire, and a character count does not bound that — a run of CJK text is
/// three bytes per character. Cutting mid-character would produce a string the
/// client cannot decode, so the cut walks back to the nearest boundary.
pub(crate) fn truncate_bytes(s: &str, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s.to_string(), false);
    }
    let mut cut = max;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    (s[..cut].to_string(), true)
}

/// Cut `s` to at most `max` characters, saying so when it does.
///
/// Characters rather than bytes, unlike a payload body: this bounds a *label*
/// that sits on one line, where the unit that matters is how much of it a reader
/// sees rather than how much of it travels.
pub(crate) fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max).collect();
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(text: &str) -> Payload {
        Payload {
            text: text.to_string(),
            is_json: false,
            truncated: false,
        }
    }

    #[test]
    fn a_body_over_the_ceiling_is_cut_and_says_so() {
        let mut budget = 1024;
        let cut = spend(&mut budget, &payload(&"x".repeat(100)), 10);
        assert_eq!(cut.text.len(), 10);
        assert!(cut.truncated, "a cut body must say it was cut");
        assert_eq!(budget, 1014, "the page paid for what travelled");
    }

    #[test]
    fn a_body_is_present_even_at_zero_budget() {
        // Emptied and marked, not dropped: "this response could not carry it"
        // and "the transcript did not record it" are different facts, and the
        // client reads the difference from the field's absence.
        let mut budget = 0;
        let cut = spend(&mut budget, &payload("something"), 1024);
        assert_eq!(cut.text, "");
        assert!(cut.truncated);
    }

    #[test]
    fn a_cut_stops_on_a_character_boundary() {
        // Three-byte characters: a byte-bounded cut that ignored boundaries
        // would produce a string the client cannot decode.
        let s = "中".repeat(100);
        let (cut, truncated) = truncate_bytes(&s, 10);
        assert!(truncated);
        assert_eq!(cut.len(), 9, "cut mid-character: {cut:?}");
        assert_eq!(cut, "中中中");
    }

    #[test]
    fn a_short_body_is_passed_through_untouched() {
        let mut budget = 1024;
        let kept = spend(&mut budget, &payload("short"), 1024);
        assert_eq!(kept.text, "short");
        assert!(!kept.truncated);
        assert_eq!(budget, 1019);
    }

    #[test]
    fn a_label_is_cut_by_characters_not_bytes() {
        // The summary is one line in a collapsed row: what matters is how much
        // of it a reader sees. Cutting by bytes would halve a CJK label.
        assert_eq!(truncate_chars("中中中中中", 3), "中中中…");
        assert_eq!(truncate_chars("abc", 3), "abc");
    }
}
