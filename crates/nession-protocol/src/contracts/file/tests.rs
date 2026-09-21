use super::v1::*;

#[test]
fn a_chunked_read_omits_its_window_rather_than_sending_null() {
    // `offset`/`limit` are the boundary that matters here: absent means "from
    // the start, whole file", and `null` would be a *stated* absence. #750's
    // truncation notice reads this, and a client that had to tell "the server
    // sent null" from "the key was not there" would be reading the wrong one.
    let whole = FileReadPayload {
        path: "/tmp/a".to_string(),
        offset: None,
        limit: None,
    };
    let json = serde_json::to_value(&whole).unwrap();
    assert!(json.get("offset").is_none(), "absent, not null: {json}");
    assert!(json.get("limit").is_none(), "absent, not null: {json}");

    let back: FileReadPayload = serde_json::from_value(json).unwrap();
    assert!(back.offset.is_none() && back.limit.is_none());
}

#[test]
fn a_chunked_read_carries_both_bounds_when_it_has_them() {
    let chunked = FileReadPayload {
        path: "/tmp/a".to_string(),
        offset: Some(4096),
        limit: Some(4096),
    };
    let back: FileReadPayload =
        serde_json::from_value(serde_json::to_value(&chunked).unwrap()).unwrap();
    assert_eq!(back.offset, Some(4096));
    assert_eq!(back.limit, Some(4096));
}

#[test]
fn a_delete_defaults_to_not_recursive() {
    // The default is the safe direction and it is a *behaviour* default, not a
    // formatting one: an older client that never heard of `recursive` must not
    // have its deletes start removing directory contents.
    let json = serde_json::json!({ "path": "/tmp/dir" });
    let msg: FileDeletePayload = serde_json::from_value(json).unwrap();
    assert!(!msg.recursive, "absent must mean the old, narrow behaviour");

    let explicit = serde_json::json!({ "path": "/tmp/dir", "recursive": true });
    let msg: FileDeletePayload = serde_json::from_value(explicit).unwrap();
    assert!(msg.recursive);
}

#[test]
fn a_rename_names_both_ends() {
    let msg = FileRenamePayload {
        from: "/tmp/a".to_string(),
        to: "/tmp/b".to_string(),
    };
    let back: FileRenamePayload =
        serde_json::from_value(serde_json::to_value(&msg).unwrap()).unwrap();
    assert_eq!((back.from.as_str(), back.to.as_str()), ("/tmp/a", "/tmp/b"));
}

#[test]
fn cwd_answers_with_a_path_though_it_asks_with_a_session() {
    // The asymmetry is the contract: the question is about a session, the
    // answer is about a filesystem. Spelling that out here so a later change
    // that "tidies" it into a path request has to argue with a test.
    let ask = FileCwdPayload {
        session_id: "agent-a:work".to_string(),
    };
    let back: FileCwdPayload = serde_json::from_value(serde_json::to_value(&ask).unwrap()).unwrap();
    assert_eq!(back.session_id, "agent-a:work");

    let answer = FileCwdResponse {
        path: "/home/u/project".to_string(),
    };
    let back: FileCwdResponse =
        serde_json::from_value(serde_json::to_value(&answer).unwrap()).unwrap();
    assert_eq!(back.path, "/home/u/project");
}

// --- the byte-level fixtures (#875) ---

#[test]
fn the_fixtures_decode_into_the_shapes_they_are_evidence_about() {
    // These read a file rather than build a value. The difference is where the
    // shape comes from: `FileReadPayload { .. }` serialised here would be the
    // type agreeing with itself, which it does forever.
    use crate::contracts::fixtures::fixture;

    let whole: FileReadPayload = fixture("read-window-absent.json").decode();
    assert!(whole.offset.is_none() && whole.limit.is_none());

    // Present and null decodes to the same value as absent. That is why the
    // distinction has to be made on the way *out* — it is lost on the way in,
    // and a consumer reading the raw JSON cannot tell the two clients apart.
    let explicit: FileReadPayload = fixture("read-window-explicit-null.json").decode();
    assert_eq!(
        (explicit.offset, explicit.limit),
        (whole.offset, whole.limit),
        "explicit null and an absent key must decode alike"
    );

    let chunked: FileReadPayload = fixture("read-window-chunked.json").decode();
    assert_eq!(chunked.offset, Some(4096));
    assert_eq!(chunked.limit, Some(4096));

    let legacy_delete: FileDeletePayload = fixture("delete-legacy-no-recursive.json").decode();
    assert!(
        !legacy_delete.recursive,
        "an older client that never sent `recursive` must not start deleting \
         directory contents"
    );
}
