//! `agent.p2p.*` — the credentials a Server issues for direct Agent connections.
//!
//! The Agent's P2P socket is not only the terminal data plane: it dispatches
//! session management and the file sandbox too. Until #1013 the Server minted a
//! credential for it and the Agent validated nothing, so **anything that could
//! reach the Agent's port had unauthenticated session and file management**.
//!
//! These contracts carry the missing half. The Server stays the issuer; the
//! Agent becomes the verifier; and `agent.p2p.grant` is how the record travels
//! between them — over the connection the Agent itself dialled out, which is the
//! only channel in this tree that is already authenticated in the direction that
//! matters ([`super::super::super`] has the argument).

use serde::{Deserialize, Serialize};

/// What a P2P credential authorizes.
///
/// Deliberately coarse, and deliberately explicit. #1013 permits a coarse scope
/// where the product has a single-user security model, and forbids only the
/// thing that is not permitted to be coarse: *"credential was valid once"* must
/// not silently imply every future P2P operation. So the shape states what is
/// granted, and the Agent enforces it per wire rather than trusting the
/// credential to have meant something narrower.
///
/// The axis is *what kind of work*, not *which connection*: one credential is
/// meant to cover a browser's terminal, its file panel and its session list,
/// because those share one socket today. Narrowing that is a product change, not
/// a hardening one.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialScope {
    /// The session the terminal plane is bound to.
    ///
    /// `Some(name)` grants `agent.attach`, `agent.detach`, `agent.terminal.input`
    /// and `agent.terminal.resize` for **that session only** — a credential
    /// minted for one session must not open another's PTY. `None` grants no
    /// terminal access at all, which is what a relay credential minted for a
    /// non-terminal purpose would use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<String>,
    /// Session management on this one agent: create, kill, list.
    #[serde(default)]
    pub sessions: bool,
    /// The file sandbox on this one agent.
    #[serde(default)]
    pub files: bool,
}

impl CredentialScope {
    /// Everything a browser's attach is given today.
    ///
    /// Behaviour-preserving on purpose. The Web binds its files API and its
    /// terminal to the *same* agent socket, so a narrower attach credential
    /// would break the product rather than harden it — the file and session
    /// narrowing belongs in its own change, with a second minting path.
    pub fn for_attach(session_name: &str) -> Self {
        Self {
            terminal: Some(session_name.to_string()),
            sessions: true,
            files: true,
        }
    }

    /// What a relay credential is given: the terminal, and nothing else.
    ///
    /// The Server's relay leg sends `agent.attach`, `agent.detach` and terminal
    /// I/O and nothing more, so this is a real boundary rather than a
    /// precaution — a relay credential that cannot write files or kill sessions
    /// costs nothing and is testable.
    pub fn for_relay(session_name: &str) -> Self {
        Self {
            terminal: Some(session_name.to_string()),
            sessions: false,
            files: false,
        }
    }
}

/// `agent.p2p.grant` — the Server hands the Agent a credential to honour.
///
/// One grant per credential, sent **before** the token is returned to the
/// client, and acknowledged. That ordering is the whole point of the wire: a
/// client that dials the Agent the instant it holds a token is then correct by
/// construction, because the verifier already has the record.
///
/// `credential` is opaque to the Agent — it never parses or derives it, only
/// looks it up. That is what lets the Server change how a token is generated
/// without the Agent changing, and it is why the token is not signed: the
/// channel it travels on is the Agent's own authenticated outbound connection.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct P2pGrantPayload {
    /// Correlates the Server's command with the Agent's acknowledgement.
    pub request_id: String,
    /// The opaque credential, exactly as it will be presented on the agent URL.
    pub credential: String,
    /// The agent this credential is for. The Agent refuses a grant naming
    /// another agent rather than storing it — a credential that cannot be
    /// mistaken for one addressed elsewhere is the difference between a target
    /// binding and a comment.
    pub agent_id: String,
    /// The session this grant is about, `agent_id:session_name`.
    pub session_id: String,
    pub scope: CredentialScope,
    /// When the credential stops being honoured, RFC 3339.
    ///
    /// A string rather than a timestamp because that is how every other time in
    /// these contracts travels, and because the Agent compares it against its
    /// own clock rather than doing arithmetic on it.
    pub expires_at: String,
}

/// `agent.p2p.grant`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct P2pGrantResponse {
    /// `"accepted"` or `"refused"`.
    pub status: String,
    pub message: String,
}
