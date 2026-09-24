//! The agent's half of the binding contract (`#1005`).
//!
//! A Nession session's Claude binding is written by a shell hook and read by
//! [`TmuxSessionContext`](crate::claude_session_context::TmuxSessionContext).
//! The two never meet, so the only thing keeping them in step is that they
//! derive the path the same way — and a disagreement has no symptom: the read
//! simply never finds the file, which is indistinguishable from a session whose
//! Claude has not started yet. The capability would quietly answer with the
//! candidate list forever, and every individual piece would look correct.
//!
//! So the derivation lives here, once. [`env_for`] hands the path to the hook
//! and [`file_for`] is what the reader opens; `env_for` is built from
//! `file_for`, which is what makes them unable to drift rather than merely
//! unlikely to.

use std::path::PathBuf;

use nession_claude_code::binding::{binding_filename, BINDING_FILE_ENV, SESSION_ID_ENV};
use nession_common::paths::agent_claude_bindings_dir;

/// The file `session_name`'s binding is written to, and read from.
///
/// `None` when the agent cannot name its own state directory. That is not fatal
/// anywhere it is used: the session still works, its Claude conversation is
/// simply not bound.
///
/// `session_name` is a tmux session name — the same string the agent put in
/// `NESSON_SESSION_ID` — not a wire session id. Normalising an id is the
/// caller's job, and both callers do it with
/// [`extract_session_name`](crate::server::websocket::extract_session_name).
pub(crate) fn file_for(session_name: &str) -> Option<PathBuf> {
    Some(
        agent_claude_bindings_dir()
            .ok()?
            .join(binding_filename(session_name)),
    )
}

/// The variables to inject into `session_name`, so Claude's hook can report.
///
/// Empty when the agent cannot name its own state directory — the caller
/// injects nothing, and the session runs with no binding rather than with a
/// path nothing will ever write to.
///
/// This reads no filesystem and creates nothing. The hook writes with `cat >`,
/// so the directory it names has to exist — but creating it here would give
/// session creation a side effect nobody asked for, and would put the
/// developer's real state directory in the path of every test that creates a
/// session. The agent creates it at startup, beside the plugin whose hook needs
/// it, which is also the only time it can matter: the hook cannot run before it
/// is installed.
pub(crate) fn env_for(session_name: &str) -> Vec<(String, String)> {
    let Some(file) = file_for(session_name) else {
        return Vec::new();
    };
    vec![
        (SESSION_ID_ENV.to_string(), session_name.to_string()),
        (
            BINDING_FILE_ENV.to_string(),
            file.to_string_lossy().into_owned(),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hook_is_told_about_the_file_the_reader_will_open() {
        // The claim is one of identity, not of two similar-looking paths: the
        // string in the environment and the path opened later are the same
        // value. Both come from `file_for`, so this cannot pass while they
        // differ — it exists to keep them coming from it.
        let env = env_for("nession-test-sess");
        let reported = env
            .iter()
            .find(|(name, _)| name == BINDING_FILE_ENV)
            .map(|(_, value)| value.clone())
            .expect("the hook is told where to write");

        assert_eq!(
            PathBuf::from(reported),
            file_for("nession-test-sess").expect("the agent can name its own state directory"),
        );
    }

    #[test]
    fn the_injected_names_are_the_ones_the_hook_looks_for() {
        // Pinned against the constants rather than against literals, because
        // the hook is a shell script that cannot import them. `plugin.rs` holds
        // the other end of this: the script's text must contain these names.
        let names: Vec<String> = env_for("s").into_iter().map(|(name, _)| name).collect();
        assert_eq!(names, vec![SESSION_ID_ENV, BINDING_FILE_ENV]);
    }

    #[test]
    fn the_session_id_injected_is_the_name_the_hook_reports_back() {
        // The hook writes `NESSON_SESSION_ID` into the payload it copies, and
        // the reader later normalises a wire id back to this same string. A
        // mismatch here would file one session's conversation under another.
        let env = env_for("nession-test-sess");
        let reported = env
            .iter()
            .find(|(name, _)| name == SESSION_ID_ENV)
            .map(|(_, value)| value.as_str())
            .expect("the hook is told which session it is");
        assert_eq!(reported, "nession-test-sess");
    }
}
