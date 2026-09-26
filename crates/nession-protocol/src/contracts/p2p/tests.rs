use super::agent_url_with_credential;
use super::v1::*;
use serde_json::json;

/// The two scopes the Server mints differ, and in the direction that matters.
///
/// A relay credential is the narrow one: the Server's relay leg sends
/// `agent.attach`, `agent.detach` and terminal I/O and nothing else. If this
/// ever reports the two as equal, the relay has been handed session and file
/// authority it has no use for.
#[test]
fn the_relay_scope_is_narrower_than_the_attach_scope() {
    let attach = CredentialScope::for_attach("work");
    let relay = CredentialScope::for_relay("work");

    assert_eq!(attach.terminal.as_deref(), Some("work"));
    assert_eq!(relay.terminal.as_deref(), Some("work"));

    assert!(attach.sessions, "a browser's attach manages sessions");
    assert!(attach.files, "a browser's attach uses the file sandbox");

    assert!(
        !relay.sessions,
        "the relay leg never creates or kills a session"
    );
    assert!(!relay.files, "the relay leg never touches a file");
}

/// A scope missing a field grants nothing by that field's name.
///
/// The failure this guards is the one that makes a permission model worse than
/// none: a shape whose absent value means "allowed". `Default` is the deny
/// case, and serde has to agree with it.
#[test]
fn an_absent_field_grants_nothing() {
    let parsed: CredentialScope = serde_json::from_value(json!({})).expect("empty object parses");

    assert_eq!(parsed, CredentialScope::default());
    assert_eq!(parsed.terminal, None, "no session named means no PTY");
    assert!(!parsed.sessions);
    assert!(!parsed.files);
}

/// A scope with no terminal binding omits the key rather than sending null.
#[test]
fn an_unbound_terminal_is_not_serialized() {
    let none = serde_json::to_value(CredentialScope::default()).expect("serialises");

    assert!(
        none.get("terminal").is_none(),
        "an unbound terminal must not travel as a key at all: {none}"
    );
}

/// The grant round-trips, scope and all.
#[test]
fn a_grant_round_trips() {
    let grant = P2pGrantPayload {
        request_id: "req-1".to_string(),
        credential: "opaque-token".to_string(),
        agent_id: "node-1".to_string(),
        session_id: "node-1:work".to_string(),
        scope: CredentialScope::for_relay("work"),
        expires_at: "2026-09-25T13:00:00Z".to_string(),
    };

    let wire = serde_json::to_string(&grant).expect("serialises");
    let back: P2pGrantPayload = serde_json::from_str(&wire).expect("deserialises");

    assert_eq!(back.credential, "opaque-token");
    assert_eq!(back.agent_id, "node-1");
    assert_eq!(back.scope, CredentialScope::for_relay("work"));
    assert_eq!(back.expires_at, "2026-09-25T13:00:00Z");
}

/// The credential goes on as `token=`, spelled against the literal.
///
/// The literal, not [`CREDENTIAL_PARAM`], on purpose: the function builds this
/// URL *from* the constant, so comparing against the constant would pass for
/// any spelling at all and pin nothing. What is worth pinning is the value,
/// because `token` is also written by hand in the Web's `buildAgentWsUrl` and
/// nothing generates either one — a rename here that does not reach there is a
/// browser whose every agent connection is refused.
#[test]
fn a_credential_is_appended_as_the_token_parameter() {
    assert_eq!(
        agent_url_with_credential("ws://agent.example.com/ws", "abc"),
        "ws://agent.example.com/ws?token=abc"
    );
}

/// A URL that already carries a query gets `&`, not a second `?`.
///
/// `…?x=1?token=abc` parses the credential as part of the *first* parameter's
/// value, so it never arrives — and the far end sees a well-formed URL with no
/// credential on it, which is not a shape anything can report as malformed.
#[test]
fn a_url_that_already_has_a_query_gets_an_ampersand() {
    assert_eq!(
        agent_url_with_credential("ws://a/ws?x=1", "abc"),
        "ws://a/ws?x=1&token=abc"
    );
}

/// No credential means no parameter — not an empty one.
///
/// This is the rule the Server's and the client's copies disagreed about: the
/// Server appended `token=` unconditionally. An empty value makes "no
/// credential" and "the empty credential" the same bytes, and the Agent's
/// verifier has to treat one of them as an answer.
#[test]
fn no_credential_adds_nothing() {
    assert_eq!(
        agent_url_with_credential("ws://agent.example.com/ws", ""),
        "ws://agent.example.com/ws"
    );
}

/// A URL with no path gets one, because a query cannot be appended without it.
///
/// `ws://host:port` is a working agent URL — an absolute URI with an empty path
/// implies `/` — and it stops working the moment a query is put on it: the
/// request target becomes `?token=abc`, which is not origin-form, so the server
/// drops the connection during the handshake and the client is left with an
/// opaque `HandshakeIncomplete`. Measured: this is exactly what a mock listener
/// that binds `127.0.0.1:0` and publishes `ws://host:port` produced, and it is
/// the reason this rule exists rather than being an edge case in theory.
#[test]
fn a_url_with_no_path_gets_one() {
    assert_eq!(
        agent_url_with_credential("ws://127.0.0.1:8080", "abc"),
        "ws://127.0.0.1:8080/?token=abc"
    );
}

/// The path is only inserted where it is missing.
///
/// The other half of the rule above, and the one that would be broken by
/// inserting unconditionally: a URL that already has a path must not get a
/// second slash, and a relative one has no authority to insert after.
#[test]
fn a_url_that_already_has_a_path_is_left_alone() {
    assert_eq!(
        agent_url_with_credential("ws://host:8080/ws", "abc"),
        "ws://host:8080/ws?token=abc"
    );
    assert_eq!(agent_url_with_credential("/ws", "abc"), "/ws?token=abc");
}

/// A credential that needs escaping is escaped.
///
/// Base64url never needs this, so the assertion has to use a character the
/// current generator cannot produce — otherwise it would pass with the encoder
/// deleted. A `+` left raw arrives at the far side as a space and reads as an
/// unknown credential, which is a different bug report from a malformed URL.
#[test]
fn a_credential_that_needs_escaping_is_escaped() {
    assert_eq!(
        agent_url_with_credential("ws://a/ws", "a+b/c"),
        "ws://a/ws?token=a%2Bb%2Fc"
    );
}

/// The acknowledgement names an outcome, and `"accepted"` is one of them.
///
/// Asserted against the literal because the Server branches on it: a response
/// that spelled the status differently would fail an attach with no indication
/// of why.
#[test]
fn a_grant_acknowledgement_names_its_outcome() {
    let accepted = P2pGrantResponse {
        status: "accepted".to_string(),
        message: "stored".to_string(),
    };

    let wire = serde_json::to_value(&accepted).expect("serialises");
    assert_eq!(wire["status"], "accepted");
}
