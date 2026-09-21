use super::v1::*;

#[test]
fn the_server_info_answer_carries_its_manifest_as_the_server_sends_it() {
    // Read from bytes rather than built, because the shape of this field is the
    // thing worth pinning: `protocols` is a *map* keyed by unit id, not a list
    // of units. A consumer that expected an array would compile against the
    // type and fail on the wire — the class of mistake no round trip can see.
    use crate::contracts::fixtures::fixture;

    let payload: ServerInfoResponse = fixture("info-with-manifest.json").decode();
    let manifest = payload
        .protocol_manifest
        .expect("the fixture carries a manifest, and so does every server");

    assert_eq!(manifest.provider, "nession-server");
    assert!(manifest.offers(&crate::ProtocolId::new("session.attach").unwrap()));
    assert!(
        !manifest.offers(&crate::ProtocolId::new("git.status").unwrap()),
        "a unit the server does not serve must not be claimed"
    );
}
