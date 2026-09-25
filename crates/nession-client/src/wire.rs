//! The wires this consumer speaks, named once.
//!
//! Until this file existed, **no Rust consumer could name a wire without a
//! string literal**: the name lived only as a literal in a provider's route
//! table and as a `wires:` entry in the codegen catalog, and the generated
//! `PROTOCOL`/`WIRE` constants were emitted for TypeScript only. That is why
//! `nession-cli` spelled `"server.agent.list"` at a call site, and why #1015's
//! requirement that a wire rename fail compilation had nothing to hook onto.
//!
//! These are **consumer references, not declarations of things that exist.**
//! The provider declares its wire; this file is the claim that this consumer
//! intends to speak it. A claim can be wrong, and being told so is the point —
//! `just check-protocol` resolves each constant used at a call site against the
//! generated tree and reports `no runtime answers \`…\`` (rule 1b) when it names
//! a wire nobody serves.
//!
//! ## The rule for editing this file
//!
//! **Do not write an envelope key here — not in a constant, not in a doc
//! comment, not in an example.** Spell the field by name in prose if you must
//! discuss it; never write the quoted key followed by a colon.
//!
//! The reason is mechanical and hostile to good intentions. `declaringFiles()`
//! in `scripts/protocol-gate.mjs` reads **raw file text with no comment
//! masking**, and classifies a file as "declares wires" if it either contains a
//! route-table macro or contains an envelope key. A declaring file has every
//! dotted `pub const` in it added to the **advertised** set — so the moment this
//! file qualifies, the constants below stop being checked and start being the
//! standard they are checked against, and a misspelling at a call site is
//! accepted because it advertises itself. That is the #913 failure, which the
//! gate's own comment records as measured and reverted once already, and
//! `just protocol-check-selftest` now pins it so this file cannot acquire the
//! property quietly.
//!
//! Being outside the advertised set is also just true: these name wires the
//! *Server* answers, and this crate answers nothing.

/// `server.auth` — the handshake, sent by [`crate::ClientConnection::connect`].
pub const SERVER_AUTH: &str = "server.auth";

/// `server.agent.list` — every agent the Server knows about.
pub const SERVER_AGENT_LIST: &str = "server.agent.list";

/// `server.session.list` — sessions, optionally scoped to one agent.
pub const SERVER_SESSION_LIST: &str = "server.session.list";

/// `server.session.attach` — ask the Server how to reach a session.
pub const SERVER_SESSION_ATTACH: &str = "server.session.attach";

// ── The agent-facing wires ──────────────────────────────────────────────────
//
// These are sent on a socket to an **agent**, not to the Server, and they are
// the terminal's traffic rather than a management path — see
// [`crate::p2p`] for why that distinction is load-bearing. They are named here
// for the same reason the server wires are: until this list existed, the only
// place a consumer could get one was `nession_agent`'s own `msg_types`, which
// made a provider's private module the source of a consumer's wire names.

/// `agent.attach` — attach a PTY to a session.
///
/// Sent on **two** transports: a fresh agent socket in P2P mode, and the Server
/// connection in relay mode.
pub const AGENT_ATTACH: &str = "agent.attach";

/// `agent.terminal.input` — keystrokes. One-way: nothing answers them.
pub const AGENT_TERMINAL_INPUT: &str = "agent.terminal.input";

/// `agent.terminal.resize` — a size change. One-way, like input.
pub const AGENT_TERMINAL_RESIZE: &str = "agent.terminal.resize";

/// `agent.terminal.output` — the agent pushing PTY output to a client.
///
/// A **notification**, not an operation: the agent emits it and nothing
/// answers. It is declared in the file that sends it rather than carried by the
/// catalog, which is why it has no sibling entry here for a reply.
pub const AGENT_TERMINAL_OUTPUT: &str = "agent.terminal.output";
