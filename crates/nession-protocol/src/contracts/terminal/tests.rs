use super::v1::*;

#[test]
fn terminal_input_round_trips() {
    // `data` is base64. It is a `String` on the wire rather than `Vec<u8>`
    // because JSON has no bytes, and asserting the *encoded* form here is the
    // point: a contract that stored the raw bytes would round-trip in Rust and
    // break in every non-Rust consumer.
    let msg = TerminalInputPayload {
        session_name: "work".to_string(),
        data: "aGVsbG8=".to_string(),
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains("\"aGVsbG8=\""));

    let back: TerminalInputPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(back.session_name, "work");
    assert_eq!(back.data, "aGVsbG8=");
}

#[test]
fn a_resize_carries_both_dimensions() {
    // Both are required, and deliberately not defaulted: a resize that named
    // only one dimension would leave the other ambiguous, and guessing it is
    // how a terminal ends up 80 columns wide on a phone.
    let json = serde_json::json!({
        "session_name": "work",
        "cols": 120,
        "rows": 40,
    });
    let msg: TerminalResizePayload = serde_json::from_value(json).unwrap();
    assert_eq!((msg.cols, msg.rows), (120, 40));

    let missing = serde_json::json!({ "session_name": "work", "cols": 120 });
    assert!(
        serde_json::from_value::<TerminalResizePayload>(missing).is_err(),
        "rows is not optional — a half-specified size is a bug, not a default"
    );
}

#[test]
fn terminal_output_mirrors_input() {
    // Same shape as `terminal.input` on purpose: the two directions of one
    // stream, and a reader that handled them differently would be handling the
    // same bytes twice.
    let msg = TerminalOutputPayload {
        session_name: "work".to_string(),
        data: "d29ybGQ=".to_string(),
    };
    let back: TerminalOutputPayload =
        serde_json::from_str(&serde_json::to_string(&msg).unwrap()).unwrap();
    assert_eq!(back.data, "d29ybGQ=");
}
