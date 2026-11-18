//! Claude CLI process identity (`#3779`).
//!
//! The control and activity paths need to know whether a Session hosts the
//! Claude CLI before they ask the CLI about itself. A command *display* is not
//! an identity: a Session's own shell-adapter path, a working directory or a
//! log filename may contain "claude" without being the CLI. This predicate
//! therefore looks at the resolved executable and at the program/script
//! positions only — arguments after the script are user data.
//!
//! One owner for both consumers: the status probe and the activity adapter must
//! agree on what a Claude process is.

/// Whether a discovered process is the Claude CLI itself.
///
/// `executable` is the resolved executable path; `command` is the sanitized
/// display whose first token is the program as invoked and whose first argument
/// is the script path for the npm JS entry.
pub fn is_claude_cli_process(executable: &str, command: &str) -> bool {
    let exe = basename(executable.trim_matches('"'));
    if is_claude_binary(exe) {
        return true;
    }
    let mut tokens = command.split_whitespace();
    // `argv[0]` survives a symlinked native install even when the resolved
    // executable file is version-named (`.../versions/2.1.326`).
    let program = tokens.next().unwrap_or("");
    if is_claude_binary(basename(program.trim_matches('"'))) {
        return true;
    }
    // A script wrapper (`#!/bin/sh`) resolves to the interpreter, with the
    // script as the first argument: accept only a real interpreter plus a
    // script whose own name is the CLI. The same position carries the npm JS
    // entry `node .../@anthropic-ai/claude-code/cli.js` for older installs.
    let Some(first_arg) = tokens.next() else {
        return false;
    };
    let program = basename(program.trim_matches('"'));
    let is_interpreter = ["sh", "bash", "dash", "zsh", "node", "nodejs", "bun", "deno"]
        .iter()
        .any(|name| program.eq_ignore_ascii_case(name));
    if !is_interpreter {
        return false;
    }
    let first_arg = first_arg.trim_matches('"').trim_matches('\'');
    let script = basename(first_arg);
    if is_claude_binary(script) {
        return true;
    }
    first_arg.ends_with("/cli.js") && first_arg.contains("@anthropic-ai/claude-code/")
}

fn basename(value: &str) -> &str {
    value.rsplit(['/', '\\']).next().unwrap_or(value)
}

fn is_claude_binary(name: &str) -> bool {
    name.eq_ignore_ascii_case("claude") || name.eq_ignore_ascii_case("claude.exe")
}

#[cfg(test)]
mod tests {
    use super::is_claude_cli_process;

    #[test]
    fn the_native_npm_binary_is_the_cli() {
        assert!(is_claude_cli_process(
            "/opt/agent-clis/claude-live/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
            "claude.exe --session-id 550e8400-e29b-41d4-a716-446655440000",
        ));
    }

    #[test]
    fn a_native_symlinked_install_is_the_cli_by_its_argv0() {
        assert!(is_claude_cli_process(
            "/home/user/.local/share/claude/versions/2.1.326",
            "claude --resume 550e8400-e29b-41d4-a716-446655440000",
        ));
    }

    #[test]
    fn the_node_js_entry_is_the_cli() {
        assert!(is_claude_cli_process(
            "/usr/bin/node",
            "node /opt/npm/node_modules/@anthropic-ai/claude-code/cli.js --resume 550e8400",
        ));
    }

    #[test]
    fn a_shell_script_wrapper_named_claude_is_the_cli() {
        assert!(is_claude_cli_process(
            "/bin/sh",
            "sh /tmp/bin/claude --version"
        ));
        assert!(is_claude_cli_process(
            "/bin/bash",
            "bash /home/user/bin/claude"
        ));
    }

    #[test]
    fn a_session_shell_adapter_path_that_mentions_claude_is_not_the_cli() {
        // The Linux bash adapter is `bash --rcfile <home>/sessions/<name>/...`.
        assert!(!is_claude_cli_process(
            "/bin/bash",
            "bash --rcfile /tmp/nession/home/sessions/claude-live/shell/bash/bashrc -i",
        ));
        assert!(!is_claude_cli_process("zsh", "zsh -i"));
    }

    #[test]
    fn an_argument_that_mentions_claude_is_not_the_cli() {
        assert!(!is_claude_cli_process(
            "tail",
            "tail -f /var/log/claude.log"
        ));
        assert!(!is_claude_cli_process(
            "vim",
            "vim /home/user/claude/notes.md"
        ));
        assert!(!is_claude_cli_process(
            "python3",
            "python3 claude_client.py"
        ));
    }
}
