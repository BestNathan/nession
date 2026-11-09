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
//!
//! ## The path is fenced by the tmux Session instance (`#2974`)
//!
//! A tmux Session name is reusable: deleting `s` and creating `s` again yields
//! a different Session that happens to share the name. A name-derived file
//! would let the new instance read the deleted instance's conversation, and a
//! `SessionEnd` hook still finishing from the deleted instance could write one
//! *after* the recreate. The filename therefore carries the tmux Session's
//! `@nession_instance_id` (`#2789`), which dies with the Session and survives an
//! Agent restart with it. The create delivers the same id to the Session's
//! environment so the hook and the reader agree even before the durable option
//! is first read.
//!
//! A Session created by an Agent that predates this fence was handed
//! [`legacy_file_for`]'s name-derived path and its hook keeps writing there for
//! the rest of its life; the reader still reads that path for those Sessions.
//! Nothing creates a binding there any more.

use std::path::{Path, PathBuf};

use nession_claude_code::binding::{
    binding_filename, binding_filename_for_instance, BINDING_FILE_ENV, SESSION_ID_ENV,
};
use nession_common::paths::agent_claude_bindings_dir;

/// The file `session_name`'s binding is written to and read from, fenced by the
/// tmux Session instance that produced it (`#2974`).
///
/// `None` when the agent cannot name its own state directory. That is not fatal
/// anywhere it is used: the session still works, its Claude conversation is
/// simply not bound.
///
/// `session_name` is a tmux session name — the same string the agent put in
/// `NESSON_SESSION_ID` — not a wire session id. Normalising an id is the
/// caller's job, and both callers do it with
/// [`extract_session_name`](crate::server::websocket::extract_session_name).
pub(crate) fn file_for(session_name: &str, instance_id: &str) -> Option<PathBuf> {
    Some(
        agent_claude_bindings_dir()
            .ok()?
            .join(binding_filename_for_instance(session_name, instance_id)),
    )
}

/// [`file_for`] under an explicit root.
///
/// The production root is the Agent's state directory; tests own a temporary
/// root so they exercise the real derivation without touching it.
pub(crate) fn file_for_in(root: &Path, session_name: &str, instance_id: &str) -> PathBuf {
    root.join(binding_filename_for_instance(session_name, instance_id))
}

/// The name-derived file a Session created before the instance fence (`#2974`)
/// was handed.
///
/// Read only. Its hook still writes here because the path was fixed when that
/// Session started, and dropping the read would lose a valid binding across an
/// Agent upgrade. A Session created since the fence never reads this path —
/// [`env_for`] no longer produces it — so a stale file left by a deleted
/// Session cannot be inherited by a new one.
pub(crate) fn legacy_file_for(session_name: &str) -> Option<PathBuf> {
    Some(
        agent_claude_bindings_dir()
            .ok()?
            .join(binding_filename(session_name)),
    )
}

/// [`legacy_file_for`] under an explicit root, for tests.
pub(crate) fn legacy_file_for_in(root: &Path, session_name: &str) -> PathBuf {
    root.join(binding_filename(session_name))
}

/// The variables to inject into `session_name`, so Claude's hook can report.
///
/// Empty when the agent cannot name its own state directory — the caller
/// injects nothing, and the session runs with no binding rather than with a
/// path nothing will ever write to.
///
/// This reads no filesystem and creates nothing. The hook writes with `cat >`,
/// so the directory it names has to exist — but creating it here would give
/// session creation a filesystem side effect nobody asked for, and would put the
/// developer's real state directory in the path of every test that creates a
/// session. The agent creates it at startup, beside the plugin whose hook needs
/// it, which is also the only time it can matter: the hook cannot run before it
/// is installed.
pub(crate) fn env_for(session_name: &str, instance_id: &str) -> Vec<(String, String)> {
    let Some(file) = file_for(session_name, instance_id) else {
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
        let instance = "2f0a6c1e-0d43-4a6e-9f7c-3c1d2e4b5a60";
        let env = env_for("nession-test-sess", instance);
        let reported = env
            .iter()
            .find(|(name, _)| name == BINDING_FILE_ENV)
            .map(|(_, value)| value.clone())
            .expect("the hook is told where to write");

        assert!(
            reported.ends_with(&format!(".{instance}.json")),
            "the hook must be handed the instance-fenced file: {reported}"
        );
        assert_eq!(
            PathBuf::from(reported),
            file_for("nession-test-sess", instance)
                .expect("the agent can name its own state directory"),
        );
    }

    #[test]
    fn the_injected_names_are_the_ones_the_hook_looks_for() {
        // Pinned against the constants rather than against literals, because
        // the hook is a shell script that cannot import them. `plugin.rs` holds
        // the other end of this: the script's text must contain these names.
        let names: Vec<String> = env_for("s", "instance")
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(names, vec![SESSION_ID_ENV, BINDING_FILE_ENV]);
    }

    #[test]
    fn the_session_id_injected_is_the_name_the_hook_reports_back() {
        // The hook writes `NESSON_SESSION_ID` into the payload it copies, and
        // the reader later normalises a wire id back to this same string. A
        // mismatch here would file one session's conversation under another.
        let env = env_for("nession-test-sess", "instance");
        let reported = env
            .iter()
            .find(|(name, _)| name == SESSION_ID_ENV)
            .map(|(_, value)| value.as_str())
            .expect("the hook is told which session it is");
        assert_eq!(reported, "nession-test-sess");
    }

    #[test]
    fn two_instances_of_one_name_are_handed_different_files() {
        // The fence, at the only place that can decide it: the deleted
        // Session's hook and a recreated Session's hook must not be pointed at
        // one file.
        let old = env_for("s", "instance-old");
        let new = env_for("s", "instance-new");
        assert_ne!(old, new);

        let root = Path::new("/state");
        assert_ne!(
            file_for_in(root, "s", "instance-old"),
            file_for_in(root, "s", "instance-new")
        );
        assert_ne!(
            file_for_in(root, "s", "instance-new"),
            legacy_file_for_in(root, "s"),
            "a fenced instance never reads a pre-fence file"
        );
    }
}
