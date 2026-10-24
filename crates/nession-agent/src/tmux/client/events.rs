//! The client's ordered source-event stream.
//!
//! One channel carries every source fact the Agent may need to act on. They
//! share a channel on purpose: output, an authoritative size change and a
//! source loss are one timeline from one control attachment, and a consumer
//! that received them on separate channels would have to reconstruct an order
//! the wire already gave it. The Agent then assigns epoch/sequence to what it
//! receives; the Client does not.

/// A tmux pane byte chunk, still in source order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneOutput {
    /// tmux's `%<pane-id>` (for example `%0`).
    pub pane_id: String,
    /// Unescaped pane bytes. **Not UTF-8**: tmux may emit any valid byte.
    pub data: Vec<u8>,
}

/// One event from the control attachment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TmuxEvent {
    /// tmux's own welcome pair (`%begin`/`%end` with no command) closed. No
    /// command was answered by it, and it is the moment the channel accepts a
    /// command whose reply is unambiguously its own (#1228).
    Handshaken,
    /// Pane output, already unescaped from tmux's `%output` framing.
    Output(PaneOutput),
    /// The response block of the command marked as a bootstrap capture **opened**
    /// (`%begin`). tmux executes a control command synchronously, so output
    /// before this event is what the pane read includes; output after the
    /// block is generated after the read and is live. The barrier needs both
    /// boundaries: dropping everything up to [`TmuxEvent::Capture`] would also
    /// drop the output that follows the read.
    CaptureStarted,
    /// The response body of a command marked as a bootstrap capture, in stream
    /// order. Output delivered before [`TmuxEvent::CaptureStarted`] is covered
    /// by the capture; output after the block is live. tmux does not
    /// interleave notifications inside a response block (measured on `-C` and
    /// `-CC`), so the block — including notification-shaped lines — is body.
    /// A capture that fails produces no event, so the barrier falls back on its
    /// own deadline.
    Capture { body: Vec<u8> },
    /// The window's authoritative size changed. Deduplicated: tmux 3.6b emits
    /// two `%layout-change` lines for one `resize-window`, and a layout change
    /// that only splits a pane is not a size change.
    Resize { cols: u16, rows: u16 },
    /// tmux sent `%exit`; the attachment is ending on its own terms.
    Exited,
    /// The byte source ended or failed. Every pending command has been
    /// resolved with an error and no later event will arrive.
    SourceLost { reason: String },
}
