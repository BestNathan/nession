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
