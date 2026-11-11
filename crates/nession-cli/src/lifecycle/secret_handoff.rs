//! How a background start hands a credential to the child it re-executes.
//!
//! `nession agent start` runs in the background by re-executing this same
//! binary with `--foreground` (#1016). The child needs the effective auth token
//! the parent resolved — flag beats env beats config file. It used to receive it
//! as `--auth-token <secret>`, which put a credential in a command line that
//! lives as long as the Agent (#2269): process listings, diagnostics and
//! crash/report tooling could read it for the daemon's whole lifetime, long
//! after the initiating CLI invocation was gone.
//!
//! The credential now travels over the child's stdin instead. The parent writes
//! one frame — a decimal byte length, a newline, then the token — and closes the
//! pipe; the child is told to read it by a non-secret argument
//! (`--auth-token-stdin`), so nothing about the value is in the child's argv.
//! The frame exists only in kernel memory between the two processes, and the
//! child drains it at startup, so the exposure ends there rather than lasting
//! for the daemon's lifetime.
//!
//! The length header is what makes the frame self-delimiting: a parent that
//! dies before writing leaves a closed pipe, which the child reads as "no
//! frame" and reports instead of silently running with an empty token. An empty
//! token is still representable (`0\n`) because no-auth mode is a real value.
//!
//! Only the immediate child is told to read the channel. The argument does not
//! propagate the way an environment variable would, so a `nession agent start`
//! typed into a Session later cannot inherit "read a credential from stdin".

use anyhow::{bail, Context, Result};
use std::io::{BufRead, Read, Write};
use std::process::Child;

/// The largest credential the channel accepts.
///
/// A token is a short opaque string; anything larger is not one, and refusing
/// it before writing keeps a corrupt or hostile value from turning the startup
/// handoff into an unbounded write/read.
const MAX_SECRET_BYTES: usize = 64 * 1024;

/// Largest header `read_auth_token_from` will consume before deciding the
/// stream is not one of ours.
const MAX_HEADER_BYTES: u64 = 20;

/// The argument that tells a foreground child to read its credential from
/// stdin. It is an argument, not the credential: see the module documentation.
pub const AUTH_TOKEN_STDIN_ARG: &str = "--auth-token-stdin";

/// Frame a credential for the child: `<byte length>\n<token>`.
///
/// One owner for the wire shape, so the parent that writes and the child that
/// reads cannot disagree about it.
fn framed_token(token: &str) -> Result<Vec<u8>> {
    if token.len() > MAX_SECRET_BYTES {
        bail!(
            "the auth token is {} bytes, larger than the {MAX_SECRET_BYTES}-byte handoff limit; \
             put it in the agent config file or the auth-token environment variable instead",
            token.len()
        );
    }
    let mut frame = format!("{}\n", token.len()).into_bytes();
    frame.extend_from_slice(token.as_bytes());
    Ok(frame)
}

/// Parent half: write the credential to the child's stdin, then close it.
///
/// Closing the write end is part of the protocol — the child reads a fixed
/// count after the header, but a writer that stayed open would be a second
/// owner of the same secret for as long as the Agent runs.
pub fn write_auth_token(child: &mut Child, token: &str) -> Result<()> {
    let frame = framed_token(token)?;
    let mut stdin = child.stdin.take().context(
        "the background child has no stdin pipe to receive the auth token; the child was \
         not started with a handoff channel",
    )?;
    stdin
        .write_all(&frame)
        .and_then(|()| stdin.flush())
        .context("failed to hand the auth token to the background child")?;
    Ok(())
}

/// Child half: the credential a parent handed off over stdin.
///
/// Called only when [`AUTH_TOKEN_STDIN_ARG`] was passed. The caller is the
/// foreground child of a background start; a user who types the argument by
/// hand gets a clear framing error rather than a token synthesized from
/// whatever happened to be on their terminal.
pub fn read_auth_token() -> Result<String> {
    let stdin = std::io::stdin();
    read_auth_token_from(&mut stdin.lock())
}

/// Read one framed credential from `reader`.
///
/// Separated from stdin so the framing can be asserted without reconfiguring
/// the test process's stdin.
fn read_auth_token_from<R: BufRead>(reader: &mut R) -> Result<String> {
    let mut header = String::new();
    let read = (&mut *reader)
        .take(MAX_HEADER_BYTES)
        .read_line(&mut header)
        .context("failed to read the auth-token handoff header")?;
    if read == 0 {
        bail!(
            "the parent process ended before handing off the auth token; \
             start the agent without {AUTH_TOKEN_STDIN_ARG}"
        );
    }
    if !header.ends_with('\n') {
        bail!("the auth-token handoff header is not terminated");
    }
    let length: usize = header
        .trim_end()
        .parse()
        .context("the auth-token handoff header is not a byte length")?;
    if length > MAX_SECRET_BYTES {
        bail!(
            "the auth-token handoff announces {length} bytes, larger than the \
             {MAX_SECRET_BYTES}-byte limit"
        );
    }

    let mut secret = vec![0u8; length];
    reader
        .read_exact(&mut secret)
        .context("the auth-token handoff ended before the token did")?;
    String::from_utf8(secret).context("the handed-off auth token is not UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::process::{Command, Stdio};

    const SECRET: &str = "fake-auth-token-for-2269";

    #[test]
    fn a_framed_token_is_read_back() {
        let mut reader = Cursor::new(framed_token(SECRET).expect("frame"));
        assert_eq!(read_auth_token_from(&mut reader).expect("read"), SECRET);
    }

    /// No-auth mode is spelled with an empty token, so an empty frame has to
    /// mean "the credential is empty", not "no credential arrived".
    #[test]
    fn an_empty_token_is_not_a_missing_handoff() {
        let mut reader = Cursor::new(b"0\n".to_vec());
        assert_eq!(read_auth_token_from(&mut reader).expect("read"), "");
    }

    /// The failure the header exists for: a parent that died before writing
    /// leaves a closed pipe, and the child must not run with an empty token.
    #[test]
    fn a_closed_channel_is_an_error() {
        let mut reader = Cursor::new(Vec::new());
        assert!(
            read_auth_token_from(&mut reader).is_err(),
            "a closed channel must not read as an empty credential"
        );
    }

    #[test]
    fn a_truncated_frame_is_an_error() {
        let mut reader = Cursor::new(b"10\nabc".to_vec());
        assert!(
            read_auth_token_from(&mut reader).is_err(),
            "a short frame must not be accepted as a credential"
        );
    }

    #[test]
    fn an_over_long_frame_is_refused_before_allocating() {
        let mut reader = Cursor::new(format!("{}\n", MAX_SECRET_BYTES + 1).into_bytes());
        assert!(read_auth_token_from(&mut reader).is_err());
    }

    #[test]
    fn an_unterminated_header_is_an_error() {
        let mut reader = Cursor::new(b"10".to_vec());
        assert!(read_auth_token_from(&mut reader).is_err());
    }

    #[test]
    fn an_oversized_token_is_refused_before_spawn() {
        let token = "x".repeat(MAX_SECRET_BYTES + 1);
        assert!(framed_token(&token).is_err());
    }

    /// The parent's write half reaches the child over a real pipe, and closing
    /// it is what lets the reader finish.
    #[cfg(unix)]
    #[test]
    fn the_parent_frames_the_token_over_a_pipe() {
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn cat");
        write_auth_token(&mut child, SECRET).expect("write");
        let output = child.wait_with_output().expect("wait");
        assert_eq!(output.stdout, framed_token(SECRET).expect("frame"));
    }
}
