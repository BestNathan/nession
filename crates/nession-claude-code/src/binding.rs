//! The exact Nession-session ↔ Claude-session binding (#1005).
//!
//! ## Why a binding exists at all
//!
//! Everything else in this capability can be answered from a working directory:
//! which transcripts exist, what they contain. What a cwd *cannot* answer is
//! **which of them is the one this Session is running right now** — and
//! `#1005`'s first constraint is that an unprovable answer is worse than none.
//! Two Nession sessions in the same directory, each running Claude, are exactly
//! the case that makes a guess wrong (success criterion 1).
//!
//! The proof comes from Claude Code itself. Its hooks receive a JSON object on
//! stdin carrying `session_id`, `transcript_path` and `cwd`, and a plugin can
//! declare a hook that runs on `SessionStart` / `SessionEnd`. So the binding is
//! *reported*, not inferred.
//!
//! ## The hook does not parse anything
//!
//! The agent injects two variables into every session it creates:
//! `NESSON_SESSION_ID` and the path of the file that session's binding belongs
//! in. The hook's whole body is:
//!
//! ```sh
//! [ -n "$NESSON_SESSION_ID" ] || exit 0
//! cat > "$NESSON_BINDING_FILE"
//! ```
//!
//! That is deliberate. Parsing Claude's JSON in shell would need `jq` (not
//! guaranteed present) or a hand-rolled extractor (guaranteed wrong eventually);
//! and the hook knows nothing about which Nession session it is in — but the
//! *agent* does, because it injected the variable. So the hook copies bytes and
//! this module does the reading, with one parser instead of two.
//!
//! The first line is `#1005` decision 6: the plugin is installed at user scope
//! so it is available everywhere, and it must be a **no-op outside a Nession
//! session** — no binding written, nothing observable.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The environment variable that marks a session as Nession-managed.
///
/// The hook exits on its absence, which is what makes a user-scope install
/// harmless: Claude Code started from any other terminal runs the same plugin
/// and it does nothing.
pub const SESSION_ID_ENV: &str = "NESSON_SESSION_ID";

/// The environment variable naming where this session's binding belongs.
///
/// Computed by the agent, not by the hook: the hook would have to know the
/// agent's state directory and how session ids are made safe for a filename,
/// and a second implementation of either is a second thing to get wrong.
pub const BINDING_FILE_ENV: &str = "NESSON_BINDING_FILE";

/// A Claude session a Nession session has been bound to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    /// Claude's own session id.
    pub claude_session_id: String,
    /// Where that conversation's transcript is.
    pub transcript_path: PathBuf,
    /// The cwd Claude reported — kept so a caller can see the binding is for the
    /// directory it is asking about, rather than trusting that it must be.
    pub cwd: String,
    /// The hook that reported it.
    pub event: HookEvent,
}

/// Which lifecycle point produced a binding.
///
/// The distinction decides whether a conversation may be presented as live
/// (`#1005` criterion 4): a binding from `SessionEnd` is a real, usable
/// conversation whose Claude has finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    /// Claude started — this conversation is running now.
    SessionStart,
    /// Claude finished — the conversation is readable and no longer live.
    SessionEnd,
    /// A lifecycle point this version does not model.
    ///
    /// Kept rather than rejected: an unrecognised event is still evidence that
    /// Claude was here, and discarding it would lose the binding over a name
    /// change. It is *not* treated as `SessionStart`, because claiming a
    /// finished conversation is live is the one wrong direction.
    Other,
}

/// The subset of a hook payload this capability needs.
///
/// Everything else Claude sends is ignored, and none of it is required: a
/// payload missing a field this version expects yields `None` rather than a
/// partial binding. Upstream adding or renaming fields must not be able to
/// produce a binding that names the wrong transcript (`#1005` constraint 7).
#[derive(Debug, Deserialize)]
struct HookPayload {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    transcript_path: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    hook_event_name: Option<String>,
}

/// Read a binding from what a hook wrote.
///
/// `None` for every way this can fail — an absent file, an empty one, a
/// payload missing something essential. The caller's next question is always
/// "then what do we show", and the answer is the candidate list, so there is
/// nothing here for a caller to act on that `None` does not already say.
pub fn read(path: &Path) -> Option<Binding> {
    let raw = std::fs::read_to_string(path).ok()?;
    parse(&raw)
}

/// Parse a hook payload into a binding.
pub fn parse(raw: &str) -> Option<Binding> {
    let payload: HookPayload = serde_json::from_str(raw).ok()?;

    // All three are required, and `?` rather than a default: a binding that
    // named a transcript without knowing which Claude session it belongs to, or
    // without a path, would be a claim this module cannot support.
    let claude_session_id = payload.session_id?;
    let transcript_path = payload.transcript_path?;
    let cwd = payload.cwd?;

    if claude_session_id.trim().is_empty() || transcript_path.trim().is_empty() {
        return None;
    }

    Some(Binding {
        claude_session_id,
        transcript_path: PathBuf::from(transcript_path),
        cwd,
        event: match payload.hook_event_name.as_deref() {
            Some("SessionStart") => HookEvent::SessionStart,
            Some("SessionEnd") => HookEvent::SessionEnd,
            // Including absent: not knowing the lifecycle point is not the same
            // as knowing Claude started.
            _ => HookEvent::Other,
        },
    })
}

/// The filename a session's binding lives in.
///
/// Session names reach this from a tmux session name, which can hold characters
/// a filename should not. Anything outside `[A-Za-z0-9._-]` becomes `_`, and a
/// name that sanitises to nothing falls back to a fixed stem — the binding is
/// per-session and the directory is per-agent, so a collision here would need
/// two sessions whose names differ only in unsafe characters.
pub fn binding_filename(session_id: &str) -> String {
    let mut safe: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() || safe.chars().all(|c| c == '.') {
        safe = "session".to_string();
    }
    safe.push_str(".json");
    safe
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(session: &str, path: &str, cwd: &str, event: &str) -> String {
        format!(
            r#"{{"session_id":"{session}","transcript_path":"{path}","cwd":"{cwd}","hook_event_name":"{event}","extra":"ignored"}}"#
        )
    }

    #[test]
    fn a_session_start_payload_binds_the_conversation() {
        let binding = parse(&payload(
            "abc",
            "/home/u/.claude/projects/-w/abc.jsonl",
            "/w",
            "SessionStart",
        ))
        .expect("a complete payload binds");
        assert_eq!(binding.claude_session_id, "abc");
        assert_eq!(binding.cwd, "/w");
        assert_eq!(binding.event, HookEvent::SessionStart);
    }

    #[test]
    fn a_session_end_binding_is_kept_and_marked_finished() {
        // The conversation stays readable after Claude exits (#1005 criterion
        // 4), so this must not be discarded — only not called live.
        let binding = parse(&payload("abc", "/t.jsonl", "/w", "SessionEnd")).unwrap();
        assert_eq!(binding.event, HookEvent::SessionEnd);
    }

    #[test]
    fn an_unknown_event_is_kept_but_not_treated_as_live() {
        // Upstream adds a lifecycle point: the binding is still evidence Claude
        // was here, and must not be lost — but `Other` is not `SessionStart`,
        // because claiming a finished conversation is running is the one wrong
        // direction to guess in.
        let binding = parse(&payload("abc", "/t.jsonl", "/w", "SessionResume")).unwrap();
        assert_eq!(binding.event, HookEvent::Other);
    }

    #[test]
    fn a_payload_missing_an_essential_field_binds_nothing() {
        // Each of these would otherwise be a binding naming a conversation the
        // capability cannot actually open.
        for raw in [
            "{}",
            r#"{"transcript_path":"/t.jsonl","cwd":"/w"}"#,
            r#"{"session_id":"a","cwd":"/w"}"#,
            r#"{"session_id":"a","transcript_path":"/t.jsonl"}"#,
            r#"{"session_id":"a","transcript_path":"","cwd":"/w"}"#,
            "not json",
            "",
        ] {
            assert!(parse(raw).is_none(), "bound something from {raw:?}");
        }
    }

    #[test]
    fn extra_upstream_fields_do_not_break_the_binding() {
        // The measured payloads carry far more than these four fields, and will
        // carry more later.
        let binding = parse(
            r#"{"session_id":"a","transcript_path":"/t.jsonl","cwd":"/w",
                "hook_event_name":"SessionStart","permission_mode":"acceptEdits",
                "source":"startup","future_field":{"nested":true}}"#,
        );
        assert!(binding.is_some());
    }

    #[test]
    fn a_binding_filename_is_safe_for_any_session_name() {
        assert_eq!(binding_filename("plain"), "plain.json");
        assert_eq!(binding_filename("agent:one"), "agent_one.json");
        assert_eq!(binding_filename("a/b c"), "a_b_c.json");
        // One `_` per unsafe character, so the mapping stays injective enough
        // to keep two different session names from colliding.
        assert_eq!(binding_filename("///"), "___.json");
        // Nothing usable left at all: a fixed stem, rather than a file called
        // `.json` (a dotfile) or `...json`.
        assert_eq!(binding_filename(""), "session.json");
        assert_eq!(binding_filename(".."), "session.json");
    }

    #[test]
    fn reading_a_file_that_is_not_there_binds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read(&dir.path().join("absent.json")).is_none());
    }

    #[test]
    fn a_binding_round_trips_through_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(binding_filename("s1"));
        std::fs::write(&path, payload("abc", "/t.jsonl", "/w", "SessionStart")).unwrap();
        let binding = read(&path).expect("the hook wrote it, so it is readable");
        assert_eq!(binding.claude_session_id, "abc");
    }
}
