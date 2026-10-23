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
    /// Pane output, already unescaped from tmux's `%output` framing.
    Output(PaneOutput),
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
