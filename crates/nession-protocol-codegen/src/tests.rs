//! The generator's own checks.
//!
//! Two properties, and neither is about the *text* it writes — that is what the
//! drift gate and `tsc` are for. These are about the catalog being a complete
//! and self-contained description of what this build serves, which is the part
//! a diff of the output would not tell anyone.

use crate::catalog::Unit;

fn units() -> Vec<Unit> {
    crate::units()
}

/// The protocol ids every runtime in this workspace declares, as they compose
/// them.
///
/// Four, not two. The catalog used to be checked against the two extension
/// providers alone, which was correct while it only carried them — and became
/// the thing that hid the gap `#876` is about the moment the kernel's own
/// contracts mattered, because nothing was asking whether *they* had bindings.
///
/// `served_descriptors` and `server_descriptors` are each derived from the
/// invocation that dispatches them, so this is the set a runtime actually
/// composes rather than a list kept in a fourth place.
fn advertised() -> Vec<String> {
    let mut ids: Vec<String> = nession_git::protocol::descriptors()
        .expect("nession-git can name its contracts")
        .iter()
        .chain(
            nession_claude_code::protocol::descriptors()
                .expect("nession-claude-code can name its contracts")
                .iter(),
        )
        .chain(
            nession_agent::protocol::served_descriptors()
                .expect("the agent can name what it serves")
                .iter(),
        )
        .map(|d| d.id.as_str().to_string())
        .collect();
    // The server's declaration is reachable as the manifest it serves, which is
    // the public surface — `server_descriptors` is `pub(crate)`, deliberately,
    // since nothing outside the crate dispatches by it.
    ids.extend(
        nession_server::protocol::server_manifest()
            .expect("the server can name what it serves")
            .protocols
            .keys()
            .map(|id| id.as_str().to_string()),
    );
    ids.sort();
    // The agent and the server both answer `session.create`, `env.*` and the
    // rest — one unit seen from two sides, which is the model working. The
    // comparison is over ids, so the overlap collapses here.
    ids.dedup();
    ids
}

#[test]
fn every_advertised_contract_is_in_the_catalog() {
    // The list a provider *serves* and the list this generator emits are two
    // lists, and the design's whole objection to two lists is that they drift
    // silently. This is the join: a contract added to a provider and not to the
    // catalog fails here rather than shipping a Web that cannot name it.
    let mut catalogued: Vec<String> = units().iter().map(|u| u.id.to_string()).collect();
    catalogued.sort();

    assert_eq!(
        catalogued,
        advertised(),
        "the catalog and the providers disagree about which contracts exist"
    );
}

#[test]
fn every_unit_file_is_self_contained() {
    // The same function the generator refuses to write without, run here so the
    // failure is read as a test rather than as a codegen exit. It found two real
    // omissions on its first run — `Scope`, shared between the two claude-code
    // units, and `ReadOkV1` behind `ReadResponseV1` — which is the whole reason
    // it is a check and not an assumption.
    let cfg = crate::config();
    if let Err(problem) = crate::check_self_contained(&units(), &cfg) {
        panic!("{problem}");
    }
}

#[test]
fn the_two_aliases_are_named_and_distinct() {
    // The alias names are hand-written strings, so they are the one part of the
    // catalog the compiler cannot check. A unit whose two operations collided on
    // one name would emit a file that does not compile.
    for unit in units() {
        let (Some(request), Some(response)) = (&unit.request, &unit.response) else {
            continue;
        };
        assert!(!request.0.is_empty(), "{} has no request name", unit.id);
        assert!(!response.0.is_empty(), "{} has no response name", unit.id);
        assert_ne!(
            request.0, response.0,
            "{} names its request and response the same",
            unit.id
        );
    }
}

#[test]
fn a_unit_with_a_response_also_has_a_request() {
    // The asymmetry worth forbidding, and the only one: a unit that answers has
    // to be answerable. The reverse is ordinary — half the kernel's units are
    // one-way — so it is not checked.
    for unit in units() {
        assert!(
            unit.response.is_none() || unit.request.is_some(),
            "{} answers but cannot be asked",
            unit.id
        );
    }
}

#[test]
fn an_alias_is_a_shape_and_not_a_reference_to_one() {
    // The aliases come from `inline()`, not `decl()`. `decl()` on a generic
    // returns the *generic* declaration — `type GitResponseV1<T> = …` — which
    // would leave the alias pointing at a type parameter the file never
    // declares. Pinned because the difference is one method name and the
    // failure is a `tsc` error three layers away.
    let cfg = crate::config();
    for unit in units() {
        let Some((_, response)) = unit.response else {
            continue;
        };
        let response = response(&cfg);
        assert!(
            !response.contains("type "),
            "{}'s response alias carries a declaration rather than a shape: {response}",
            unit.id
        );
    }
}
