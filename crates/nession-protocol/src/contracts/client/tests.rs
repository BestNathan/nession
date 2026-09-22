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
fn an_absent_client_id_omits_the_key_rather_than_faking_a_value() {
    // `client_id` was required, and three of the four branches that build this
    // type had nothing to put in it: the Server's `handle_client_auth` omitted
    // the key entirely, and the Agent's invalid-payload arm filled in
    // `String::new()`. An empty string is "absent" written in the only dialect a
    // required field allows — and a consumer cannot tell it from a real id.
    //
    // The test this replaces asserted the field was required, reasoning that
    // "an accepted auth without one would be an authenticated peer nothing could
    // address". That was never the mechanism: the Agent mints an id when the
    // caller sends none (`payload.client_id.unwrap_or_else(uuid)`), so it can
    // address the peer either way and never needed one echoed back.
    let msg = AuthResponsePayload {
        status: "failed".to_string(),
        message: "Invalid auth token".to_string(),
        client_id: None,
    };
    let json = serde_json::to_value(&msg).unwrap();
    assert!(
        json.get("client_id").is_none(),
        "an absent client id must omit the key, not send a null or an empty \
         string a consumer would have to know to distrust: {json}"
    );

    // The branch that genuinely has one still carries it.
    let some = AuthResponsePayload {
        status: "ok".to_string(),
        message: "welcome".to_string(),
        client_id: Some("c-1".to_string()),
    };
    let back: AuthResponsePayload =
        serde_json::from_value(serde_json::to_value(&some).unwrap()).unwrap();
    assert_eq!(back.client_id.as_deref(), Some("c-1"));
}
