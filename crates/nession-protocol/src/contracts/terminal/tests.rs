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
        input_epoch: None,
        seq_start: None,
        seq_end: None,
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

/// The same back-compat property `terminal.output`'s absent `bootstrap` rests
/// on, for the two fields #1303 added: a resize that carries no stream position
/// is **byte-identical** to the frame this contract produced before they
/// existed.
///
/// Both directions matter here and neither is free. An old *reader* must not
/// see a null it has to tolerate, and an old *writer* — the CLI's
/// `terminal.resize`, and a tmux `%window-resize` echo — must keep producing a
/// frame today's agent accepts.
///
/// Asserted against a literal rather than against a round-trip, because a
/// round-trip passes for any self-consistent shape.
#[test]
fn a_resize_without_a_stream_position_is_unchanged_on_the_wire() {
    let msg = TerminalResizePayload {
        session_name: "work".to_string(),
        cols: 120,
        rows: 40,
        control_generation: None,
        stream_epoch: None,
        stream_seq: None,
    };
    assert_eq!(
        serde_json::to_string(&msg).unwrap(),
        r#"{"session_name":"work","cols":120,"rows":40}"#
    );
}

/// And when the position is present, both halves of it survive — an epoch
/// without its sequence, or the reverse, is not something a client could place
/// in a timeline.
#[test]
fn a_recorded_resize_carries_the_position_it_was_recorded_at() {
    let msg = TerminalResizePayload {
        session_name: "work".to_string(),
        cols: 120,
        rows: 40,
        control_generation: None,
        stream_epoch: Some(1_790_771_445_798_089),
        stream_seq: Some(7),
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains(r#""stream_seq":7"#), "wire shape: {json}");

    let back: TerminalResizePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(back.stream_epoch, Some(1_790_771_445_798_089));
    assert_eq!(back.stream_seq, Some(7));
    assert_eq!((back.cols, back.rows), (120, 40));
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

/// A frame with no sequence is **byte-identical** to the frame this contract
/// produced before #1307 added the three fields.
///
/// The same property, and the same reason, as
/// `a_frame_without_a_bootstrap_is_unchanged_on_the_wire` above: it is what
/// lets a client built before the sequenced contract keep typing into an agent
/// built after it. Its bytes are written and the applied cursor does not move —
/// which [`TerminalInputPayload::input_epoch`] documents as the old meaning, and
/// which is exactly what an old sender must keep getting.
///
/// Asserted against a literal rather than a round-trip, because a round-trip
/// passes for any self-consistent shape.
#[test]
fn an_unsequenced_input_frame_is_unchanged_on_the_wire() {
    let msg = TerminalInputPayload {
        session_name: "work".to_string(),
        data: "aGVsbG8=".to_string(),
        control_generation: None,
        input_epoch: None,
        seq_start: None,
        seq_end: None,
    };
    assert_eq!(
        serde_json::to_string(&msg).unwrap(),
        r#"{"session_name":"work","data":"aGVsbG8="}"#
    );
}

/// A sequenced frame states the position it carries, in the spelling the other
/// runtimes read.
///
/// The three fields were added by #1307 and round-tripped in no test: the
/// `terminal_input_round_trips` above sets all three to `None`, so a renamed or
/// mis-attributed field would serialize to *something* and deserialize back
/// from it — passing while the agent read nothing.
///
/// The wire spelling is asserted because it is the contract: the Web's bindings
/// are generated from these structs, and the Agent parses this JSON by hand. A
/// rename on either side is not something a round-trip can catch.
#[test]
fn a_sequenced_input_frame_states_its_epoch_and_its_range() {
    let msg = TerminalInputPayload {
        session_name: "work".to_string(),
        data: "aGVsbG8=".to_string(),
        control_generation: Some(3),
        input_epoch: Some(1_790_771_445_798_089),
        seq_start: Some(4),
        seq_end: Some(6),
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(
        json.contains(r#""input_epoch":1790771445798089"#),
        "wire shape: {json}"
    );
    assert!(json.contains(r#""seq_start":4"#), "wire shape: {json}");
    assert!(json.contains(r#""seq_end":6"#), "wire shape: {json}");

    let back: TerminalInputPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(back.input_epoch, Some(1_790_771_445_798_089));
    assert_eq!((back.seq_start, back.seq_end), (Some(4), Some(6)));
    assert_eq!(back.control_generation, Some(3));
}

/// The acknowledgement is a cursor, and it carries the three things a sender
/// needs to decide what to do with it: which run it is about, how far it
/// reaches, and which lease was held when it was written.
///
/// [`TerminalInputAckPayload`] is the frame the whole delivery loop turns on,
/// and it had no test at this layer at all. `applied_through` is asserted as a
/// number rather than merely as present: it is the invariant — every chunk at or
/// below it is written to the PTY — and a field that deserialized to a zero
/// would tell every sender that nothing it had sent had landed.
#[test]
fn an_input_acknowledgement_states_its_cursor() {
    let msg = TerminalInputAckPayload {
        session_name: "work".to_string(),
        input_epoch: 1_790_771_445_798_089,
        applied_through: 12,
        control_generation: Some(3),
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(
        json.contains(r#""applied_through":12"#),
        "wire shape: {json}"
    );

    let back: TerminalInputAckPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(back.input_epoch, 1_790_771_445_798_089);
    assert_eq!(back.applied_through, 12);
    assert_eq!(back.control_generation, Some(3));
}
