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
        control_generation: None,
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
        stream_epoch: None,
        stream_seq: None,
        bootstrap: None,
    };
    let back: TerminalOutputPayload =
        serde_json::from_str(&serde_json::to_string(&msg).unwrap()).unwrap();
    assert_eq!(back.data, "d29ybGQ=");
}

/// The one property the version decision rests on: a frame with no `bootstrap`
/// is **byte-identical** to the frame this contract produced before #321 added
/// the field.
///
/// That is what "a new optional field whose absence preserves the old meaning"
/// (`docs/architecture/protocol.md`) buys, and it is not free — it is this
/// attribute pair. Drop either half and an old reader sees a null it has to
/// tolerate, or a new writer emits one an old reader may not.
///
/// Asserted against a literal rather than against a round-trip, because a
/// round-trip passes for any self-consistent shape.
#[test]
fn a_frame_without_a_bootstrap_is_unchanged_on_the_wire() {
    let msg = TerminalOutputPayload {
        session_name: "work".to_string(),
        data: "d29ybGQ=".to_string(),
        stream_epoch: None,
        stream_seq: None,
        bootstrap: None,
    };
    assert_eq!(
        serde_json::to_string(&msg).unwrap(),
        r#"{"session_name":"work","data":"d29ybGQ="}"#
    );
}

/// And when it is present, it says both of the things a client needs to decide
/// how to apply it.
#[test]
fn a_bootstrap_carries_what_was_asked_for_and_whether_it_was_cut() {
    let msg = TerminalOutputPayload {
        session_name: "work".to_string(),
        data: "d29ybGQ=".to_string(),
        stream_epoch: None,
        stream_seq: None,
        bootstrap: Some(TerminalBootstrapPayload {
            requested_lines: 5000,
            truncated: true,
        }),
    };
    let back: TerminalOutputPayload =
        serde_json::from_str(&serde_json::to_string(&msg).unwrap()).unwrap();
    let bootstrap = back.bootstrap.expect("the marker survives a round trip");
    assert_eq!(bootstrap.requested_lines, 5000);
    assert!(bootstrap.truncated);
}
