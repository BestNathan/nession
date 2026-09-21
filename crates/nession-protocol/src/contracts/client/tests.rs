use super::v1::*;

#[test]
fn an_absent_token_is_an_empty_string_not_a_missing_field() {
    // `auth_token` defaults rather than being required, so a client that sends
    // nothing gets the same *shape* of answer as one that sends the wrong
    // token. Rejecting the frame instead would make "you did not authenticate"
    // and "your message was malformed" the same event at the far end, and only
    // one of those is worth retrying.
    let msg: ClientAuthPayload = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(msg.auth_token, "");
    assert!(msg.client_id.is_none());
}

#[test]
fn auth_response_always_names_a_client() {
    // `client_id` is required, and it is what the agent keys per-connection
    // state on. An accepted auth without one would be an authenticated peer
    // nothing could address.
    let msg = AuthResponsePayload {
        status: "ok".to_string(),
        message: "welcome".to_string(),
        client_id: "c-1".to_string(),
    };
    let back: AuthResponsePayload =
        serde_json::from_value(serde_json::to_value(&msg).unwrap()).unwrap();
    assert_eq!(back.client_id, "c-1");
}
