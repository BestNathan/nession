//! The Claude Code integration plugin the Agent owns (#1005 decisions 1 and 5).
//!
//! ## What this is, and what it is not
//!
//! It is a plugin **for Claude Code**, written and owned entirely by Nession, so
//! that a Claude session inside a Nession Session can tell the agent who it is.
//! It is not a Nession plugin, and it is not something a user installs or
//! manages — the agent writes it, registers it, and refreshes it on every start.
//!
//! That ownership is why the identity is namespaced: `nession-agent` for the
//! plugin and `nession-integration` for the marketplace. A user may later
//! install Nession plugins of their own, and those must never be confused with
//! this one — not by name, not by directory, and not by the agent's refresh
//! overwriting them.
//!
//! ## Why the hook body is two lines of shell
//!
//! See [`crate::binding`]: the agent injects the session id and the binding
//! file's path into the session, so the hook copies stdin to a file and parses
//! nothing. The alternative — extracting `transcript_path` in shell — would need
//! `jq` (not guaranteed) or hand-rolled matching (wrong eventually), and would
//! put Claude's payload format in two places.
//!
//! The guard on the first line is `#1005` decision 6. The plugin is installed at
//! user scope so it is present everywhere; Claude Code started from any other
//! terminal runs it too, and there it must do nothing at all.

use std::path::{Path, PathBuf};

/// The plugin's own name, and the directory it lives in.
pub const PLUGIN_NAME: &str = "nession-agent";

/// The marketplace's name, deliberately different from the plugin's.
pub const MARKETPLACE_NAME: &str = "nession-integration";

/// The plugin version.
///
/// The crate's own version, which is the workspace's — so it moves with every
/// Nession release without anyone remembering to update it here. That matters
/// more than it looks: Claude Code decides whether a plugin is already current
/// from the declared version, so a plugin whose *content* changed while its
/// version did not would be skipped as already-latest and keep running the old
/// hook (decision 5).
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// A file the plugin consists of: its path inside the plugin root, and contents.
pub struct PluginFile {
    pub path: PathBuf,
    pub contents: String,
}

/// The hook body, shared by every lifecycle event that records a binding.
///
/// `sh`, not `bash`: this runs on whatever the host has, and it uses nothing
/// beyond `[`, `cat` and redirection.
const HOOK_SCRIPT: &str = r#"#!/bin/sh
# Written by nession-agent. Do not edit — it is overwritten on every start.
#
# Reports this Claude session's identity to the Nession agent that started it.
#
# Outside a Nession session there is nothing to report and nothing is written:
# this plugin is installed at user scope so it is present everywhere, and every
# other terminal must see it as a no-op (#1005 decision 6).
[ -n "$NESSON_SESSION_ID" ] || exit 0
[ -n "$NESSON_BINDING_FILE" ] || exit 0

# Claude sends the payload on stdin. Copied verbatim: the agent knows which
# session it injected the variables into, so it parses, not this script.
cat > "$NESSON_BINDING_FILE"
"#;

/// Build the plugin's files.
///
/// Pure: everything is derived from `version`, so a test can assert the whole
/// artifact without touching a filesystem.
pub fn render(version: &str) -> Vec<PluginFile> {
    vec![
        PluginFile {
            path: PathBuf::from(".claude-plugin/marketplace.json"),
            contents: format!(
                r#"{{
  "name": "{MARKETPLACE_NAME}",
  "owner": {{ "name": "Nession" }},
  "metadata": {{
    "description": "Nession's own integration for Claude Code. Managed by nession-agent; not for manual installation.",
    "version": "{version}"
  }},
  "plugins": [
    {{
      "name": "{PLUGIN_NAME}",
      "source": "./",
      "description": "Reports the Claude session identity to the Nession agent that owns this session. Inert outside a Nession session."
    }}
  ]
}}
"#
            ),
        },
        PluginFile {
            path: PathBuf::from(".claude-plugin/plugin.json"),
            contents: format!(
                r#"{{
  "name": "{PLUGIN_NAME}",
  "description": "Reports the Claude session identity to the Nession agent that owns this session. Inert outside a Nession session.",
  "version": "{version}",
  "author": {{ "name": "Nession" }}
}}
"#
            ),
        },
        PluginFile {
            path: PathBuf::from("hooks/hooks.json"),
            contents: format!(
                r#"{{
  "description": "{PLUGIN_NAME}: report the Claude session identity to Nession.",
  "hooks": {{
    "SessionStart": [
      {{
        "hooks": [
          {{
            "type": "command",
            "command": "${{CLAUDE_PLUGIN_ROOT}}/hooks/record-binding.sh"
          }}
        ]
      }}
    ],
    "SessionEnd": [
      {{
        "hooks": [
          {{
            "type": "command",
            "command": "${{CLAUDE_PLUGIN_ROOT}}/hooks/record-binding.sh"
          }}
        ]
      }}
    ]
  }}
}}
"#
            ),
        },
        PluginFile {
            path: PathBuf::from("hooks/record-binding.sh"),
            contents: HOOK_SCRIPT.to_string(),
        },
    ]
}

/// The plugin root inside `agent_state_dir`.
pub fn root_in(agent_state_dir: &Path) -> PathBuf {
    agent_state_dir.join("claude-integration")
}

/// Write the plugin into `agent_state_dir`, replacing any previous copy.
///
/// Whole-tree replacement rather than an in-place edit: Claude Code may read
/// these files at any moment, and a half-written plugin is a plugin that
/// declines to load (decision 1). The new tree is built beside the old one and
/// swapped in, so a reader sees either the previous version or the new one.
pub fn write_into(agent_state_dir: &Path, version: &str) -> std::io::Result<PathBuf> {
    let root = root_in(agent_state_dir);
    let staging = agent_state_dir.join(format!(".{PLUGIN_NAME}.staging"));

    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }

    for file in render(version) {
        let target = staging.join(&file.path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&target, file.contents)?;
    }
    // The hook is a program. Written non-executable it would be a plugin that
    // loads and then silently never reports anything.
    make_executable(&staging.join("hooks/record-binding.sh"))?;

    // Swap. `remove_dir_all` first because rename onto an existing directory is
    // not portable; the window between the two is the reason the version is
    // declared in the manifests rather than inferred — a reader that catches the
    // gap sees a missing plugin, not a mixture of two.
    if root.exists() {
        std::fs::remove_dir_all(&root)?;
    }
    if let Some(parent) = root.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&staging, &root)?;
    Ok(root)
}

/// Mark a file executable by its owner.
#[cfg(unix)]
fn make_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> std::io::Result<()> {
    // Claude Code on Windows runs hook commands through a shell that does not
    // consult the executable bit.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file<'a>(files: &'a [PluginFile], path: &str) -> &'a str {
        files
            .iter()
            .find(|f| f.path == Path::new(path))
            .map(|f| f.contents.as_str())
            .unwrap_or_else(|| panic!("{path} is part of the plugin"))
    }

    #[test]
    fn the_manifests_parse_as_json() {
        let files = render("1.2.3");
        for name in [
            ".claude-plugin/marketplace.json",
            ".claude-plugin/plugin.json",
            "hooks/hooks.json",
        ] {
            let parsed: serde_json::Result<serde_json::Value> =
                serde_json::from_str(file(&files, name));
            assert!(
                parsed.is_ok(),
                "{name} is not valid JSON: {:?}",
                parsed.err()
            );
        }
    }

    #[test]
    fn the_declared_version_follows_the_argument() {
        // This is what keeps Claude Code from deciding an updated plugin is
        // already current and leaving the old hook in place (decision 5).
        let files = render("9.9.9");
        for name in [
            ".claude-plugin/marketplace.json",
            ".claude-plugin/plugin.json",
        ] {
            assert!(
                file(&files, name).contains("9.9.9"),
                "{name} did not carry the version"
            );
        }
    }

    #[test]
    fn the_plugin_and_marketplace_identities_are_distinct() {
        // A future user-installed Nession plugin must not collide with this one
        // (decision 1), so the marketplace is not named after the plugin.
        let files = render("1.0.0");
        let marketplace = file(&files, ".claude-plugin/marketplace.json");
        assert!(marketplace.contains("\"name\": \"nession-integration\""));
        assert!(marketplace.contains("\"name\": \"nession-agent\""));
        assert_ne!(PLUGIN_NAME, MARKETPLACE_NAME);
    }

    #[test]
    fn both_lifecycle_events_are_hooked() {
        // SessionStart is what makes a conversation live; SessionEnd is what
        // lets a finished one stay readable (criterion 4). Losing the second
        // would leave the binding claiming Claude was still running.
        let files = render("1.0.0");
        let hooks = file(&files, "hooks/hooks.json");
        assert!(hooks.contains("\"SessionStart\""));
        assert!(hooks.contains("\"SessionEnd\""));
        assert!(hooks.contains("${CLAUDE_PLUGIN_ROOT}/hooks/record-binding.sh"));
    }

    #[test]
    fn the_hook_is_a_no_op_outside_a_nession_session() {
        // The whole reason a user-scope install is acceptable.
        let files = render("1.0.0");
        let script = file(&files, "hooks/record-binding.sh");
        assert!(
            script.contains(r#"[ -n "$NESSON_SESSION_ID" ] || exit 0"#),
            "the hook would act outside a Nession session"
        );
        assert!(
            script.contains(r#"[ -n "$NESSON_BINDING_FILE" ] || exit 0"#),
            "the hook would write somewhere it was not told to"
        );
        // And it must do no work before that guard.
        let guard_line = script
            .lines()
            .position(|l| l.contains("NESSON_SESSION_ID"))
            .expect("the guard is present");
        let first_command = script
            .lines()
            .position(|l| l.starts_with("cat "))
            .expect("the write is present");
        assert!(
            guard_line < first_command,
            "the hook writes before it checks whether it should"
        );
    }

    #[test]
    fn the_hook_parses_nothing() {
        // A parser here would be a second copy of Claude's payload format, in a
        // language with no JSON library guaranteed to be installed.
        let files = render("1.0.0");
        let script = file(&files, "hooks/record-binding.sh");
        for tool in ["jq", "python", "sed", "grep", "awk"] {
            assert!(
                !script.contains(tool),
                "the hook reached for {tool}; the agent should be doing the parsing"
            );
        }
    }

    #[test]
    fn writing_the_plugin_produces_an_executable_hook() {
        let dir = tempfile::tempdir().unwrap();
        let root = write_into(dir.path(), "1.0.0").unwrap();

        let script = root.join("hooks/record-binding.sh");
        assert!(script.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&script).unwrap().permissions().mode();
            assert!(
                mode & 0o111 != 0,
                "a non-executable hook loads and then silently never runs: {mode:o}"
            );
        }
    }

    #[test]
    fn writing_twice_replaces_rather_than_accumulates() {
        let dir = tempfile::tempdir().unwrap();
        write_into(dir.path(), "1.0.0").unwrap();
        let root = write_into(dir.path(), "2.0.0").unwrap();

        let manifest = std::fs::read_to_string(root.join(".claude-plugin/plugin.json")).unwrap();
        assert!(
            manifest.contains("2.0.0"),
            "the old version survived a refresh"
        );
        assert!(!manifest.contains("1.0.0"));

        // And no staging directory was left behind.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("staging"))
            .collect();
        assert!(leftovers.is_empty(), "staging left behind: {leftovers:?}");
    }

    #[test]
    fn the_plugin_never_touches_a_users_own_claude_files() {
        // The agent owns this tree and nothing else. Anything outside the
        // plugin root is the user's, and decision 1 forbids overwriting it.
        let dir = tempfile::tempdir().unwrap();
        let users_settings = dir.path().join("settings.json");
        std::fs::write(&users_settings, r#"{"hooks":{"SessionStart":["mine"]}}"#).unwrap();

        write_into(dir.path(), "1.0.0").unwrap();

        assert_eq!(
            std::fs::read_to_string(&users_settings).unwrap(),
            r#"{"hooks":{"SessionStart":["mine"]}}"#,
            "the agent wrote into a file it does not own"
        );
    }
}
