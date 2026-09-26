//! The P2P credentials this Agent honours (#1013).
//!
//! The Server issues them and this Agent verifies them, which is a division of
//! labour the P2P socket never had: the Server has always minted a token, and
//! nothing ever checked it. What travels between the two is an
//! [`agent.p2p.grant`](nession_protocol::contracts::p2p::v1::P2pGrantPayload),
//! pushed over the connection **this Agent dialled out** — the one channel in
//! the tree that is already authenticated, in the direction that matters,
//! because the Agent is the client on it. Nothing inbound can reach it, and it
//! already carries every management command the Agent obeys, so the socket's
//! authority here is no stronger an assumption than the authority it already
//! acts on.
//!
//! ## Why the lock is not `tokio`'s
//!
//! [`P2pCredentials::authorize`] runs inside the WebSocket upgrade, in
//! `accept_hdr_async`'s callback, which is **synchronous** — it cannot await, so
//! a `tokio::sync::RwLock` is not merely unnecessary but unusable. The
//! invariant that makes a blocking lock safe on an async runtime is narrow and
//! worth stating: **the critical section is a `HashMap` lookup or insert and
//! never awaits, never does I/O and never calls out.** It is a few hundred
//! nanoseconds against a map bounded by the credential expiry.

use std::collections::HashMap;
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use chrono::{DateTime, Utc};
use nession_protocol::contracts::p2p::v1::{CredentialScope, P2pGrantPayload};
use tracing::warn;

/// Why a credential was not honoured.
///
/// Distinct here and **deliberately not distinct on the wire**: these choose
/// what the Agent logs, and every one of them becomes the same 401 with the
/// same body, because a refusal that says "expired" rather than "unknown" tells
/// a caller which of its guesses was closest. The log gets the reason; the peer
/// gets nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// No such credential — never issued, or swept after expiry.
    Unknown,
    /// Known and past its deadline.
    Expired,
    /// Issued, but for a different agent.
    WrongAgent,
}

/// A credential the Server granted, as this Agent holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantedCredential {
    pub agent_id: String,
    pub session_id: String,
    pub scope: CredentialScope,
    pub expires_at: DateTime<Utc>,
}

/// What a connection proved about itself at the WebSocket upgrade.
///
/// Immutable for the connection's life, and the thing every later authorization
/// question is answered from — the shape the Server already uses for
/// `registered_agent_id` (`server/handler.rs`), where a per-connection fact is
/// established once and consulted by every gate rather than re-derived per
/// handler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionAuthority {
    /// Identifies the credential for logs. **Never sent to the peer**: it is
    /// derived from the credential itself, so echoing it would hand back half
    /// of what a caller is guessing at.
    pub credential_id: String,
    pub agent_id: String,
    pub session_id: String,
    pub scope: CredentialScope,
    pub expires_at: DateTime<Utc>,
}

/// What one wire needs before a connection may run it (#1013).
///
/// Declared **beside each arm** in the agent's `p2p_routes!` table, exactly as
/// the execution policy already is, and for the same reason: a rule written next
/// to the operation it governs cannot drift from it, and a rule kept in a list
/// somewhere else is one that a new arm does not get added to.
///
/// This is the column that makes *"the credential was valid"* stop implying
/// *"every operation is allowed"*. The handshake answers one question — is there
/// a credential, and is it this agent's — and this answers the other, per frame.
pub enum WireScope {
    /// The floor, and the reason no wire needs a special case to be reachable:
    /// the connection itself — the legacy handshake, and anything that describes
    /// or keeps alive the socket rather than acting on the agent's resources.
    Connection,
    /// The terminal plane, bound to one session.
    ///
    /// **Stage 2 enforces the binding's presence, not its value.** A credential
    /// with no terminal binding at all is refused here; one bound to a *different*
    /// session is not yet, and that comparison is Stage 3's — the stage whose
    /// evidence is "a session-scoped credential refused on a different session".
    ///
    /// The split is not laziness. Comparing the name is the half that changes
    /// what every existing terminal test has to do: their session names are
    /// generated per test (`nession-test-<prefix>-<nanos>`), so a test credential
    /// bound to one name cannot cover the session the test creates, and each of
    /// those sites has to mint for its own session instead. Doing that in the
    /// same change as turning enforcement on would put a mechanical rewrite of
    /// thirty dial sites and the enforcement decision in one diff, where a
    /// failure could be either.
    Session(String),
    /// Session management on this agent: create, kill, list.
    Sessions,
    /// The file sandbox on this agent.
    Files,
}

impl ConnectionAuthority {
    /// Whether this connection may run a wire that needs `required`.
    ///
    /// The floor is deliberately not "authenticated": every connection past the
    /// upgrade has a credential, so a check that asked only that would pass for
    /// everything and mean nothing. The comparison is the credential's own
    /// scope, which is why a relay credential — terminal for one session,
    /// `sessions: false`, `files: false` — is refused on the file and session
    /// wires while still being a perfectly valid credential.
    pub fn covers(&self, required: &WireScope) -> bool {
        match required {
            WireScope::Connection => true,
            // Two conditions, and the first is the one that will not relax:
            // a frame that named no session is refused, because the answer to
            // "may I act on the session I did not name" is no, and a credential
            // that treats an unnamed frame as *any* session is a credential
            // every caller can reach every session with by omitting a field.
            //
            // The second is Stage 2's reading of the binding: present, not
            // compared. See [`WireScope::Session`] for why the comparison is
            // Stage 3's.
            WireScope::Session(name) => !name.is_empty() && self.scope.terminal.is_some(),
            WireScope::Sessions => self.scope.sessions,
            WireScope::Files => self.scope.files,
        }
    }
}

/// The credentials this Agent will honour, and the only place they live.
pub struct P2pCredentials {
    held: RwLock<HashMap<String, GrantedCredential>>,
}

impl Default for P2pCredentials {
    fn default() -> Self {
        Self::new()
    }
}

impl P2pCredentials {
    pub fn new() -> Self {
        Self {
            held: RwLock::new(HashMap::new()),
        }
    }

    /// Store a credential the Server granted, if it is addressed to this Agent.
    ///
    /// A grant naming another agent is **refused rather than stored**. That is
    /// not defensive tidiness: it is the difference between a target binding and
    /// a comment. A credential is only meaningful if the agent it names is the
    /// agent that honours it, and the check has to be somewhere — this is the
    /// only place that sees both the credential and the identity it claims.
    ///
    /// Returns the id of the stored credential for logging, or the reason it was
    /// refused.
    pub fn grant(&self, this_agent: &str, grant: &P2pGrantPayload) -> Result<String, Refusal> {
        if grant.agent_id != this_agent {
            warn!(
                granted_for = %grant.agent_id,
                this_agent,
                "refusing a P2P credential addressed to another agent"
            );
            return Err(Refusal::WrongAgent);
        }

        let expires_at = match DateTime::parse_from_rfc3339(&grant.expires_at) {
            Ok(at) => at.with_timezone(&Utc),
            Err(error) => {
                // An unparseable deadline is refused rather than defaulted: a
                // credential that never expires is a worse failure than one that
                // never works, and the Server is the only writer here.
                warn!(
                    expires_at = %grant.expires_at,
                    %error,
                    "refusing a P2P credential whose expiry cannot be read"
                );
                return Err(Refusal::Unknown);
            }
        };

        let id = credential_id(&grant.credential);
        let mut held = self.write();
        let now = Utc::now();
        // Swept on write for the same reason the Server's ledger is swept on
        // mint: this is the only moment the map grows, so it is the only moment
        // it can need shrinking.
        held.retain(|_, credential| credential.expires_at >= now);
        held.insert(
            grant.credential.clone(),
            GrantedCredential {
                agent_id: grant.agent_id.clone(),
                session_id: grant.session_id.clone(),
                scope: grant.scope.clone(),
                expires_at,
            },
        );

        Ok(id)
    }

    /// What a presented credential proves, or why it proves nothing.
    ///
    /// **Synchronous on purpose** — see the module docs. Called from the
    /// WebSocket upgrade, before any frame is read, so a caller that is refused
    /// never had a connection to leave in a half-authenticated state.
    pub fn authorize(&self, credential: &str) -> Result<ConnectionAuthority, Refusal> {
        let now = Utc::now();

        // A read first, because the overwhelmingly common case is a valid
        // credential and it should not need the write lock — and the guard is
        // **dropped before anything else runs**, which is the whole reason this
        // is a `let` with its own scope rather than an `if let`.
        //
        // `if let Some(found) = self.read().get(…)` keeps the read guard alive
        // for the body in Rust 2021, so the `forget` below would ask for a write
        // lock this same thread already holds a read lock on. `std::sync::RwLock`
        // is not reentrant and does not detect it: the thread simply stops. It
        // deadlocks the *expired* path only, which is why it survived every test
        // that never presented a stale credential.
        let held = { self.read().get(credential).cloned() };

        match held {
            Some(found) if found.expires_at >= now => Ok(authority_of(credential, &found)),
            Some(_) => {
                self.forget(credential);
                Err(Refusal::Expired)
            }
            None => Err(Refusal::Unknown),
        }
    }

    /// How many credentials are held. For tests and diagnostics.
    pub fn len(&self) -> usize {
        self.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn forget(&self, credential: &str) {
        self.write().remove(credential);
    }

    /// A poisoned lock is recovered from rather than propagated.
    ///
    /// The map holds `String`s and `bool`s, so a panic in another thread cannot
    /// have left it inconsistent — and refusing every credential forever
    /// because some unrelated task panicked would turn a local failure into a
    /// permanent outage of the P2P socket.
    fn read(&self) -> RwLockReadGuard<'_, HashMap<String, GrantedCredential>> {
        self.held
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write(&self) -> RwLockWriteGuard<'_, HashMap<String, GrantedCredential>> {
        self.held
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn authority_of(credential: &str, held: &GrantedCredential) -> ConnectionAuthority {
    ConnectionAuthority {
        credential_id: credential_id(credential),
        agent_id: held.agent_id.clone(),
        session_id: held.session_id.clone(),
        scope: held.scope.clone(),
        expires_at: held.expires_at,
    }
}

/// A short, stable tag for a credential, for logs.
///
/// Never the credential itself. A credential is the thing being guessed at, so
/// writing it to a log file is the leak this boundary exists to prevent — and a
/// log is a much easier place to read it from than a socket.
fn credential_id(credential: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    credential.hash(&mut hasher);
    format!("p2p-{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    const AGENT: &str = "node-1";

    fn grant_for(agent_id: &str, session: &str, expires_in: Duration) -> P2pGrantPayload {
        P2pGrantPayload {
            request_id: "req-1".to_string(),
            credential: "the-token".to_string(),
            agent_id: agent_id.to_string(),
            session_id: format!("{agent_id}:{session}"),
            scope: CredentialScope::for_attach(session),
            expires_at: (Utc::now() + expires_in).to_rfc3339(),
        }
    }

    #[test]
    fn a_granted_credential_authorizes() {
        let credentials = P2pCredentials::new();
        credentials
            .grant(AGENT, &grant_for(AGENT, "work", Duration::minutes(5)))
            .expect("this agent's grant is accepted");

        let authority = credentials.authorize("the-token").expect("authorized");
        assert_eq!(authority.agent_id, AGENT);
        assert_eq!(authority.session_id, "node-1:work");
        assert_eq!(authority.scope, CredentialScope::for_attach("work"));
    }

    /// A credential addressed elsewhere is refused, not stored.
    #[test]
    fn a_grant_for_another_agent_is_refused() {
        let credentials = P2pCredentials::new();

        let refusal = credentials
            .grant(AGENT, &grant_for("node-2", "work", Duration::minutes(5)))
            .expect_err("a grant for node-2 must not be stored by node-1");

        assert_eq!(refusal, Refusal::WrongAgent);
        assert_eq!(credentials.len(), 0, "and nothing was stored");
        assert_eq!(
            credentials
                .authorize("the-token")
                .expect_err("never stored"),
            Refusal::Unknown
        );
    }

    #[test]
    fn an_expired_credential_is_refused() {
        let credentials = P2pCredentials::new();
        credentials
            .grant(AGENT, &grant_for(AGENT, "work", Duration::seconds(-1)))
            .expect("the grant is well formed");

        assert_eq!(
            credentials.authorize("the-token").expect_err("expired"),
            Refusal::Expired
        );
        assert_eq!(credentials.len(), 0, "and it is dropped on the way out");
    }

    /// An unknown credential is refused without saying which of its guesses was
    /// closest — the reason travels to the log, not to the caller.
    #[test]
    fn an_unknown_credential_is_refused() {
        let credentials = P2pCredentials::new();
        credentials
            .grant(AGENT, &grant_for(AGENT, "work", Duration::minutes(5)))
            .expect("granted");

        assert_eq!(
            credentials.authorize("a-guess").expect_err("unknown"),
            Refusal::Unknown
        );
    }

    /// A credential whose deadline cannot be read is refused, not defaulted.
    ///
    /// The alternative — treating an unparseable expiry as "no expiry" — issues
    /// a credential that never stops working, from a field the Server is the
    /// only writer of. Failing closed is the only honest reading.
    #[test]
    fn a_grant_with_an_unreadable_expiry_is_refused() {
        let credentials = P2pCredentials::new();
        let mut grant = grant_for(AGENT, "work", Duration::minutes(5));
        grant.expires_at = "not a timestamp".to_string();

        assert_eq!(
            credentials.grant(AGENT, &grant).expect_err("unreadable"),
            Refusal::Unknown
        );
        assert_eq!(credentials.len(), 0);
    }

    /// Granting sweeps what has expired, so the map cannot grow without bound.
    #[test]
    fn granting_sweeps_what_has_expired() {
        let credentials = P2pCredentials::new();
        credentials
            .grant(AGENT, &grant_for(AGENT, "old", Duration::seconds(-1)))
            .expect("granted");
        assert_eq!(credentials.len(), 1, "stored before it expired");

        // A well-formed grant with a live deadline arrives.
        let mut fresh = grant_for(AGENT, "new", Duration::minutes(5));
        fresh.credential = "the-new-token".to_string();
        credentials.grant(AGENT, &fresh).expect("granted");

        assert_eq!(credentials.len(), 1, "the expired one is gone");
        assert!(credentials.authorize("the-new-token").is_ok());
    }

    // ── The scope rule (#1013) ──────────────────────────────────────────────
    //
    // `covers` is what makes "this credential was valid" stop implying "every
    // operation on this connection is allowed", so each row is asserted in
    // **both** directions: the scope it grants is accepted, and one it does not
    // is refused. A rule tested only in the granting direction passes just as
    // well when it grants everything.

    fn authority_for(scope: CredentialScope) -> ConnectionAuthority {
        ConnectionAuthority {
            credential_id: "p2p-test".to_string(),
            agent_id: AGENT.to_string(),
            session_id: format!("{AGENT}:work"),
            scope,
            expires_at: Utc::now() + Duration::minutes(5),
        }
    }

    /// The floor, and the only row every credential shares.
    #[test]
    fn the_connection_scope_is_always_covered() {
        let bare = authority_for(CredentialScope::default());

        assert!(bare.covers(&WireScope::Connection));
    }

    /// A terminal credential covers terminal frames; one without a binding does
    /// not.
    ///
    /// **Stage 2's row.** The deliberately-absent assertion is that a credential
    /// for `"work"` is refused on `"other"` — it is not, yet, and this test says
    /// so by not claiming it. When Stage 3 adds the comparison, the row that
    /// fails is this one, which is where that change should have to come.
    #[test]
    fn a_terminal_credential_covers_terminal_wires_and_a_bare_one_does_not() {
        let attach = authority_for(CredentialScope::for_attach("work"));
        assert!(attach.covers(&WireScope::Session("work".to_string())));

        let no_terminal = authority_for(CredentialScope {
            terminal: None,
            sessions: true,
            files: true,
        });
        assert!(
            !no_terminal.covers(&WireScope::Session("work".to_string())),
            "a credential with no terminal binding must not reach a terminal wire, \
             whatever session the frame names"
        );
    }

    /// A frame that names no session is refused, not treated as "any".
    ///
    /// This is the one row where the tempting reading — "no name given, so
    /// nothing to check" — is a way around the whole column: a caller that
    /// omitted `session_name` would reach every session by not naming one.
    #[test]
    fn an_unnamed_session_is_refused() {
        let attach = authority_for(CredentialScope::for_attach("work"));

        assert!(
            !attach.covers(&WireScope::Session(String::new())),
            "a frame that named no session must not match a credential for one"
        );
    }

    /// The two management rows follow the credential, in both directions.
    #[test]
    fn session_and_file_scopes_follow_the_credential() {
        let broad = authority_for(CredentialScope::for_attach("work"));
        assert!(broad.covers(&WireScope::Sessions));
        assert!(broad.covers(&WireScope::Files));

        // The relay credential: terminal for one session and nothing else,
        // which is what makes it a boundary rather than a second attach.
        let relay = authority_for(CredentialScope::for_relay("work"));
        assert!(relay.covers(&WireScope::Session("work".to_string())));
        assert!(
            !relay.covers(&WireScope::Sessions),
            "the relay leg never creates or kills a session"
        );
        assert!(
            !relay.covers(&WireScope::Files),
            "the relay leg never touches a file"
        );
    }

    /// No scope is granted by accident when the credential has a terminal
    /// binding but nothing else.
    #[test]
    fn a_terminal_only_credential_covers_no_management_row() {
        let terminal_only = authority_for(CredentialScope {
            terminal: Some("work".to_string()),
            sessions: false,
            files: false,
        });

        assert!(terminal_only.covers(&WireScope::Session("work".to_string())));
        assert!(!terminal_only.covers(&WireScope::Sessions));
        assert!(!terminal_only.covers(&WireScope::Files));
    }

    /// The id in a log line is not the credential.
    #[test]
    fn a_credential_id_does_not_reveal_the_credential() {
        let credentials = P2pCredentials::new();
        let id = credentials
            .grant(AGENT, &grant_for(AGENT, "work", Duration::minutes(5)))
            .expect("granted");

        assert!(
            !id.contains("the-token"),
            "the id must not be a way to read the credential out of a log: {id}"
        );
        assert!(id.starts_with("p2p-"), "and it should be recognisable");
    }
}
