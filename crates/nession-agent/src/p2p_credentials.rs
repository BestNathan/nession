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
    /// The terminal plane, bound to one session **by name**.
    ///
    /// The name in the frame is compared against the name in the credential.
    /// Anything else — a credential with no binding, a binding for another
    /// session, a frame that named none — is refused, and  those are three
    /// different rules that a single "has a terminal binding" test would collapse
    /// into one that grants all three.
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
            // The name is compared, not merely required to be present.
            //
            // "Has a terminal binding" is not the boundary a credential for one
            // session is supposed to be: an agent serving a hundred sessions
            // would honour any of them for a credential minted for one, and a
            // relay credential — terminal for the session being relayed and
            // nothing else — would open a different session's PTY. The binding
            // is only a binding if it is checked against the name the frame
            // carries.
            //
            // The empty name is refused for the same reason and separately: the
            // answer to "may I act on the session I did not name" is no, and a
            // credential that read an unnamed frame as *any* session would let
            // every caller reach every session by omitting a field.
            WireScope::Session(name) => {
                !name.is_empty()
                    && (self.scope.terminal_all_sessions
                        || self.scope.terminal.as_deref() == Some(name.as_str()))
            }
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

    /// Hold a credential this agent was **configured** with, rather than
    /// granted.
    ///
    /// The standalone path's only way in. `server_url = ""` has no Server to
    /// mint a credential and no outbound channel to receive a grant on, so the
    /// operator's own token is the one secret in the picture. Everything
    /// downstream is unchanged — same store, same lookup, same scope gate — so
    /// the only thing this bypasses is *delivery*, which is precisely what a
    /// grant exists to do.
    ///
    /// **Never expires**, and that is a property of having no issuer rather than
    /// a relaxation: a Server's credential is short-lived because the Server can
    /// mint another, and a configured token has no second source. Restarting
    /// the agent with a different token is the rotation.
    ///
    /// The expiry is written as the far future rather than as an absence so it
    /// travels the same path as every other credential: a store with two kinds
    /// of entry would need every reader to know which kind it had.
    pub fn grant_configured(
        &self,
        this_agent: &str,
        credential: &str,
        scope: CredentialScope,
    ) -> Result<String, Refusal> {
        let grant = P2pGrantPayload {
            request_id: "configured".to_string(),
            credential: credential.to_string(),
            agent_id: this_agent.to_string(),
            session_id: this_agent.to_string(),
            scope,
            expires_at: (Utc::now() + chrono::Duration::days(3650)).to_rfc3339(),
        };
        self.grant(this_agent, &grant)
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

    /// A terminal credential covers its own session and no other.
    ///
    /// The row that makes the binding a boundary rather than a formality. An
    /// agent serves many sessions, so "this credential has *a* terminal binding"
    /// would honour any of them for a credential minted for one — and the
    /// relay's credential, terminal for the session being relayed, would reach
    /// every other session on the node.
    #[test]
    fn a_terminal_credential_covers_only_the_session_it_names() {
        let attach = authority_for(CredentialScope::for_attach("work"));

        assert!(attach.covers(&WireScope::Session("work".to_string())));
        assert!(
            !attach.covers(&WireScope::Session("other".to_string())),
            "a credential minted for one session must not open another's PTY"
        );
    }

    /// A credential with no terminal binding covers no terminal wire at all.
    ///
    /// Separate from the row above because it fails separately: a `covers` that
    /// compared names without first checking there was a name to compare would
    /// pass that test and fail this one only if `None` happened to match, which
    /// is the shape a `Some`/`None` mix-up produces. The empty name is in the
    /// list for the same reason — it is the third way to name no session.
    #[test]
    fn a_credential_with_no_terminal_binding_covers_no_terminal_wire() {
        let no_terminal = authority_for(CredentialScope {
            terminal: None,
            terminal_all_sessions: false,
            sessions: true,
            files: true,
        });

        for named in ["work", "", "other"] {
            assert!(
                !no_terminal.covers(&WireScope::Session(named.to_string())),
                "a credential with no terminal binding must not reach a terminal \
                 wire, whatever session the frame names ({named:?})"
            );
        }
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
            terminal_all_sessions: false,
            sessions: false,
            files: false,
        });

        assert!(terminal_only.covers(&WireScope::Session("work".to_string())));
        assert!(!terminal_only.covers(&WireScope::Sessions));
        assert!(!terminal_only.covers(&WireScope::Files));
    }

    // ── The standalone path (#1013 Stage 5) ─────────────────────────────────

    /// A standalone credential covers every session, and still refuses an
    /// unnamed one.
    ///
    /// Both halves matter and they fail differently. The broad grant is the
    /// point of `for_standalone` — one operator token has to reach every
    /// session on the node, because there is no Server to mint one per session.
    /// The refusal is the part that must **not** come along with it: a
    /// credential that read an unnamed frame as "any session" would let a
    /// caller reach any of them by omitting a field, and that hole is not
    /// narrower for being on a standalone agent.
    #[test]
    fn a_standalone_credential_covers_every_session() {
        let standalone = authority_for(CredentialScope::for_standalone());

        for named in ["work", "other", "nession-test-abc-123"] {
            assert!(
                standalone.covers(&WireScope::Session(named.to_string())),
                "a standalone credential must reach {named:?}"
            );
        }
        assert!(
            !standalone.covers(&WireScope::Session(String::new())),
            "even the broad grant refuses a frame that named no session"
        );
        assert!(standalone.covers(&WireScope::Sessions));
        assert!(standalone.covers(&WireScope::Files));
    }

    /// A configured credential is held like a granted one, and survives the
    /// sweep that drops expired ones.
    ///
    /// The sweep is the specific hazard: `grant` prunes what has expired on
    /// every write, and a configured token carries a far-future deadline rather
    /// than no deadline at all precisely so it travels the same path. A store
    /// that dropped it would leave a standalone agent refusing every connection
    /// the first time any other credential arrived.
    #[test]
    fn a_configured_credential_is_honoured_and_outlives_the_sweep() {
        let credentials = P2pCredentials::new();
        credentials
            .grant_configured(
                AGENT,
                "the-operator-token",
                CredentialScope::for_standalone(),
            )
            .expect("an agent accepts the credential it was configured with");

        let authority = credentials
            .authorize("the-operator-token")
            .expect("authorized");
        assert!(authority.covers(&WireScope::Session("any".to_string())));

        // A write goes through the same store, which is what triggers the sweep.
        credentials
            .grant(AGENT, &grant_for(AGENT, "old", Duration::seconds(-1)))
            .expect("granted");

        assert!(
            credentials.authorize("the-operator-token").is_ok(),
            "a write to the store dropped the configured credential; it has no issuer to \\
             re-mint it, so losing it means the agent refuses every connection from then on"
        );
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
