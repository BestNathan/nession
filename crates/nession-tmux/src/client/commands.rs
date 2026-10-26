//! Typed operations the control client can execute.
//!
//! tmux operation semantics — which flags an operation takes, which target it
//! addresses and what its answer means — belong to the crate's one-shot
//! operation owner. Most tmux traffic is one-shot and is rendered as an argv
//! subprocess.
//!
//! A control-mode client cannot run an argv: it writes *command lines* into one
//! long-lived attachment. This enum is the transport-specific adapter for that
//! form — the same operations, encoded for the control channel. It is
//! deliberately small (only what the attached session needs) and it does not
//! introduce new semantics: every variant mirrors the corresponding one-shot
//! operation, and the migration slice that moves the one-shot owner into this
//! crate removes the argv-side duplicate from the live path.
//!
//! Every command is **one line**, because tmux answers each command with one
//! `%begin`/`%end` block. A variant that needs two tmux commands (resize asks
//! for both `resize-window` and `refresh-client`) is two values here, not one:
//! a client cannot match two reply blocks to a single waiter.

/// One tmux command line, addressed by the client's session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlCommand {
    /// `send-keys -t <target> -H <hex bytes>`: raw input, byte-exact.
    ///
    /// Hex rather than `-l` for the reason `ControlModeSession::write_input`
    /// documents: literal mode needs quoting (so some byte sequences cannot be
    /// expressed) and the outer command framing is line-delimited, so a
    /// newline in the data would end the command early.
    SendKeysHex { target: String, data: Vec<u8> },
    /// `resize-window -t <target> -x <cols> -y <rows>`.
    ResizeWindow {
        target: String,
        cols: u16,
        rows: u16,
    },
    /// `refresh-client`: ask tmux to redraw the attached client(s) after a resize.
    RefreshClient,
    /// `capture-pane -t <target> -p -S -<lines> -E - -e -J`.
    CapturePane { target: String, lines: u32 },
    /// `detach-client`: end this attachment from the inside.
    DetachClient,
}

impl ControlCommand {
    /// Render this operation as the exact bytes written to the control channel,
    /// including its trailing newline.
    pub fn encode(&self) -> Vec<u8> {
        let line = match self {
            Self::SendKeysHex { target, data } => {
                let mut hex = String::with_capacity(data.len() * 3);
                for (index, byte) in data.iter().enumerate() {
                    if index > 0 {
                        hex.push(' ');
                    }
                    hex.push_str(&format!("{byte:02x}"));
                }
                format!("send-keys -t {target} -H {hex}\n")
            }
            Self::ResizeWindow { target, cols, rows } => {
                format!("resize-window -t {target} -x {cols} -y {rows}\n")
            }
            Self::RefreshClient => "refresh-client\n".to_string(),
            Self::CapturePane { target, lines } => {
                format!("capture-pane -t {target} -p -S -{lines} -E - -e -J\n")
            }
            Self::DetachClient => "detach-client\n".to_string(),
        };
        line.into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(cmd: ControlCommand) -> String {
        String::from_utf8(cmd.encode()).expect("a control line is ASCII")
    }

    #[test]
    fn raw_input_is_hex_encoded_so_every_byte_survives() {
        // A newline, a control byte and a non-UTF-8 byte: the three cases that
        // literal send-keys or a String round-trip loses (#2300/#1096).
        let cmd = ControlCommand::SendKeysHex {
            target: "work".to_string(),
            data: vec![b'h', b'i', b'\n', 0x03, 0xff],
        };
        assert_eq!(text(cmd), "send-keys -t work -H 68 69 0a 03 ff\n");
    }

    #[test]
    fn resize_names_both_dimensions_and_the_target() {
        assert_eq!(
            text(ControlCommand::ResizeWindow {
                target: "work".to_string(),
                cols: 132,
                rows: 40,
            }),
            "resize-window -t work -x 132 -y 40\n",
        );
    }

    #[test]
    fn capture_matches_the_canonical_pane_capture_flags() {
        assert_eq!(
            text(ControlCommand::CapturePane {
                target: "work".to_string(),
                lines: 5000,
            }),
            "capture-pane -t work -p -S -5000 -E - -e -J\n",
        );
    }

    #[test]
    fn a_command_is_one_line_even_for_an_empty_payload() {
        assert_eq!(
            text(ControlCommand::SendKeysHex {
                target: "work".to_string(),
                data: Vec::new(),
            }),
            "send-keys -t work -H \n",
        );
        assert_eq!(text(ControlCommand::RefreshClient), "refresh-client\n");
        assert_eq!(text(ControlCommand::DetachClient), "detach-client\n");
    }
}
