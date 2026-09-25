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
