//! Self-contained test fixtures for this crate.
//!
//! The fake tmux records every call as one `call.N/argv` directory so tests can
//! assert the exact argv a spawn produced. It is installed by a child process
//! (`cp`) so this process never holds a write descriptor on the executable:
//! `fork` copies descriptor tables, and an `exec` of a path still open for
//! writing fails with `ETXTBSY` while this crate's tests spawn children.

use std::path::{Path, PathBuf};

use crate::process::TmuxCommand;

pub(crate) const CALL_FILE_PREFIX: &str = "call.";
pub(crate) const CALL_RECORD_NAME: &str = "argv";
pub(crate) const CALL_SEPARATOR: &str = "==call==";

#[cfg(unix)]
pub(crate) struct FakeTmux {
    bin: String,
    dir: PathBuf,
    socket: PathBuf,
}

/// Install `body` at `bin`, with the file created by a **child** process.
#[cfg(unix)]
pub(crate) fn install_via_a_child(bin: &Path, body: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let src = bin.with_extension("src");
    std::fs::write(&src, body)?;
    let status = std::process::Command::new("cp").arg(&src).arg(bin).status();
    let _ = std::fs::remove_file(&src);
    if !status?.success() {
        return Err(std::io::Error::other(
            "installing the fake tmux: cp exited with a failure status",
        ));
    }
    let mut perms = std::fs::metadata(bin)?.permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(bin, perms)
}

#[cfg(unix)]
impl FakeTmux {
    /// Write the fake into `dir`. Panics if it cannot be written or made
    /// executable — a fake that silently failed to install would take a test
    /// down a path that looks like the wiring under test.
    ///
    /// `-S`/`-f` addressing is stripped before recording: it is not the
    /// command under test, and leaving it in would make every argv assertion
    /// miss.
    pub(crate) fn new(dir: &Path, script: &str) -> Self {
        let bin = dir.join("tmux");
        install_via_a_child(
            &bin,
            &format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = \"-S\" ]; then shift 2; fi\n\
                 if [ \"$1\" = \"-f\" ]; then shift 2; fi\n\
                 n=0\n\
                 while true; do\n\
                 while [ -e \"{dir}/{prefix}$n\" ]; do n=$((n + 1)); done\n\
                 if mkdir \"{dir}/{prefix}$n\" 2>/dev/null; then break; fi\n\
                 if [ ! -d \"{dir}/{prefix}$n\" ]; then\n\
                 echo \"fake tmux: cannot claim {dir}/{prefix}$n\" >&2\n\
                 exit 1\n\
                 fi\n\
                 n=$((n + 1))\n\
                 done\n\
                 printf '%s\\n' \"$@\" \"{sep}\" > \"{dir}/{prefix}$n/{record}.tmp\" &&\n\
                 mv \"{dir}/{prefix}$n/{record}.tmp\" \"{dir}/{prefix}$n/{record}\" || exit 1\n\
                 {script}\n",
                dir = dir.display(),
                prefix = CALL_FILE_PREFIX,
                record = CALL_RECORD_NAME,
                sep = CALL_SEPARATOR,
            ),
        )
        .expect("install the fake tmux");
        Self {
            bin: bin.to_string_lossy().into_owned(),
            dir: dir.to_path_buf(),
            socket: dir.join("tmux.sock"),
        }
    }

    /// The addressing these tests inject: this binary, on a socket no server
    /// ever bound. Both halves matter — the binary makes the call observable,
    /// and the socket makes "the injection did not take" fail loudly instead of
    /// quietly reaching the harness server.
    pub(crate) fn command(&self) -> TmuxCommand {
        TmuxCommand::new(self.bin.clone(), self.socket.clone())
    }

    /// Every call recorded so far, each as the argv entries tmux received.
    pub(crate) fn calls(&self) -> Vec<Vec<String>> {
        let mut calls = Vec::new();
        for n in 0.. {
            let claimed = self.dir.join(format!("{CALL_FILE_PREFIX}{n}"));
            if !claimed.is_dir() {
                break;
            }
            let text = match std::fs::read_to_string(claimed.join(CALL_RECORD_NAME)) {
                Ok(text) => text,
                Err(_) => continue,
            };
            let text = text.trim_end_matches('\n');
            let mut body = text;
            let mut whole = false;
            while let Some(stripped) = body.strip_suffix(CALL_SEPARATOR) {
                whole = true;
                body = stripped.trim_end_matches('\n');
            }
            if !whole {
                continue;
            }
            let entries: Vec<String> = body
                .trim_matches('\n')
                .lines()
                .map(str::to_string)
                .collect();
            if !entries.is_empty() {
                calls.push(entries);
            }
        }
        calls
    }

    /// Wait until at least `n` calls have been recorded, or `deadline` passes.
    pub(crate) async fn wait_for_calls(
        &self,
        n: usize,
        deadline: std::time::Duration,
    ) -> Vec<Vec<String>> {
        let until = std::time::Instant::now() + deadline;
        loop {
            let calls = self.calls();
            if calls.len() >= n || std::time::Instant::now() >= until {
                return calls;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
}
