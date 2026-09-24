//! The generator's own checks.
//!
//! Two properties, and neither is about the *text* it writes — that is what the
//! drift gate and `tsc` are for. These are about the catalog being a complete
//! and self-contained description of what this build serves, which is the part
//! a diff of the output would not tell anyone.

use crate::catalog::Unit;
use std::collections::{BTreeMap, BTreeSet};

fn units() -> Vec<Unit> {
    crate::units()
}

/// Every Protocol Unit every runtime in this workspace declares, and the wires
/// each is declared over.
///
/// Four runtimes, not two. The catalog used to be checked against the two
/// extension providers alone, which was correct while it only carried them — and
/// became the thing that hid the gap `#876` is about the moment the kernel's own
/// contracts mattered, because nothing was asking whether *they* had bindings.
///
/// `served_descriptors` and `server_manifest` are each derived from the
/// invocation that dispatches them, so this is the set a runtime actually
/// composes rather than a list kept in a fifth place.
///
/// Wires are unioned per id, so that a unit answered on more than one transport
/// keeps both on its one entry. Since `#912` the wire and the id are the same
/// spelling and every unit has exactly one, so today the union is over a single
/// element — it stays because the alternative is a lookup that silently drops
/// the second wire the day a unit grows one.
/// Keyed by `(Protocol Unit, Contract Version)` — the identity `#963` fixes,
/// and not the id alone.
///
/// Keying by id collapsed a unit's two versions into one entry here. That is the
/// worse half of the same bug `schema.rs` had: this map is what the completeness
/// assertions below compare the catalog *against*, so a collapse would have made
/// the join agree with itself while the catalog and the providers actually
/// disagreed — the drift these tests exist to catch, hidden precisely at the
/// moment a second version appeared.
fn declared() -> BTreeMap<(String, u32), BTreeSet<String>> {
    use std::collections::{BTreeMap, BTreeSet};

    let mut map: BTreeMap<(String, u32), BTreeSet<String>> = BTreeMap::new();
    let mut add = |id: &str, version: u32, wires: &[String]| {
        map.entry((id.to_string(), version))
            .or_default()
            .extend(wires.iter().cloned());
    };

    for d in nession_git::protocol::descriptors()
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
    {
        for contract in &d.contracts {
            add(d.id.as_str(), contract.version.get(), &contract.wire);
        }
    }

    // The server's declaration is reachable as the manifest it serves, which is
    // the public surface — `server_descriptors` is `pub(crate)`, deliberately,
    // since nothing outside the crate dispatches by it.
    //
    // A manifest entry carries `versions` rather than a descriptor per version,
    // so each one is expanded here. Reading it as one version would make a
    // server unit at v1 and v2 look like one contract, which is the collapse
    // this whole function was rewritten to stop doing.
    for (id, support) in &nession_server::protocol::server_manifest()
        .expect("the server can name what it serves")
        .protocols
    {
        for version in &support.versions {
            add(id.as_str(), version.get(), &support.wire);
        }
    }

    map
}

/// Every `(id, version)` every runtime declares.
fn advertised() -> Vec<(String, u32)> {
    declared().into_keys().collect()
}

#[test]
fn every_advertised_contract_is_in_the_catalog() {
    // The list a provider *serves* and the list this generator emits are two
    // lists, and the design's whole objection to two lists is that they drift
    // silently. This is the join: a contract added to a provider and not to the
    // catalog fails here rather than shipping a Web that cannot name it.
    //
    // Compared as `(id, version)` pairs. Comparing ids made two versions of one
    // unit indistinguishable from one, so the join would have held while the
    // catalog emitted a v2 the provider never served — or omitted one it did.
    let mut catalogued: Vec<(String, u32)> = units()
        .iter()
        .map(|u| (u.id.to_string(), u.version))
        .collect();
    catalogued.sort();

    let mut served = advertised();
    served.sort();

    assert_eq!(
        catalogued, served,
        "the catalog and the providers disagree about which contracts exist"
    );
}

#[test]
fn the_catalog_names_the_wires_the_runtimes_declare() {
    // The catalog's `wires` are **string literals** — not reads of the
    // providers' `WIRE` consts — and until this test nothing compared them. The
    // completeness check above is over *ids*.
    //
    // So a wire could be spelled one way in the contract and another in the
    // catalog, and nothing said so. It happened: `just codegen` kept writing
    // `extension.git.status` after every provider const had moved to
    // `git.status`, which means the drift survived a change that moved every
    // wire in the workspace. Two spellings of one thing, inside the artefact
    // whose entire purpose is to stop that.
    //
    // The ids are checked; the wires are checked here.
    let declared = declared();
    for unit in units() {
        let Some(expected) = declared.get(&(unit.id.to_string(), unit.version)) else {
            panic!(
                "`{}` v{} is in the catalog and no runtime declares it",
                unit.id, unit.version
            );
        };

        let mut actual: Vec<&str> = unit.wires.to_vec();
        actual.sort_unstable();
        let mut expected: Vec<&str> = expected.iter().map(String::as_str).collect();
        expected.sort_unstable();

        assert_eq!(
            actual, expected,
            "the catalog and the runtimes disagree about `{}`'s wires — the \
             contract is the source of truth, not the catalog",
            unit.id
        );
    }
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
fn every_unit_declares_a_request_shape() {
    // The end state of #920, pinned so it cannot quietly regress. Before it, the
    // last eight units were identity-only: a name, a wire and two `None`s, with
    // the shape of what they carried living in whichever handler read or built
    // it — and nothing to compare that against.
    //
    // The near-reverse of the test above, and deliberately not the same claim.
    // That one says *an answering unit must be askable*; this says every unit has
    // a shape at all. A one-way unit's request is simply its message, so this
    // holds without contradicting "half the kernel's units are one-way".
    //
    // A request and not a response: `server.agent.session-update` is one-way by
    // nature — the agent reports a session's state and nothing answers.
    for unit in units() {
        assert!(
            unit.request.is_some(),
            "{} has no request shape, so a caller cannot tell what to send it",
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
        let Some((_, response, _schema)) = unit.response else {
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

// ── The JSON Schema projection ──────────────────────────────────────────────

fn collect_refs(value: &serde_json::Value, found: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, v) in map {
                if key == "$ref" {
                    if let Some(s) = v.as_str() {
                        found.insert(s.to_string());
                    }
                } else {
                    collect_refs(v, found);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for v in items {
                collect_refs(v, found);
            }
        }
        _ => {}
    }
}

/// The key one `(Protocol Unit, Contract Version)` takes under `protocols`.
///
/// Spelled here rather than imported from `schema` so the test fails if the
/// generator's spelling changes — the two agreeing is the property, and calling
/// the same function would make it true by construction.
fn protocol_key(unit: &Unit) -> String {
    format!("{}@v{}", unit.id, unit.version)
}

#[test]
fn the_document_covers_every_unit_the_catalog_declares() {
    let doc = crate::schema::document(None);
    let protocols = doc["protocols"]
        .as_object()
        .expect("protocols is an object");

    for unit in units() {
        assert!(
            protocols.contains_key(&protocol_key(&unit)),
            "`{}` v{} is in the catalog but not in the schema",
            unit.id,
            unit.version
        );
    }
    assert_eq!(
        protocols.len(),
        units().len(),
        "the schema carries a protocol the catalog does not declare"
    );
}

#[test]
fn two_versions_of_one_unit_both_survive_in_the_document() {
    // The bug this test exists for is a silent one. Keying `protocols` by the
    // unit id alone meant `Map::insert` replaced: the second version of a unit
    // did not collide, did not error, and did not appear — one contract was
    // simply absent from the document, and the only trace was a count nobody
    // had a reason to take.
    //
    // A synthetic catalog, because no shipped contract has a second version
    // yet, and the failure mode is invisible precisely until one does.
    let base = units()
        .into_iter()
        .find(|u| u.id == "git.status")
        .expect("git.status is declared");
    let mut v2 = base.clone();
    v2.version = 2;

    let doc = crate::schema::document_of(&[base, v2], None);
    let protocols = doc["protocols"]
        .as_object()
        .expect("protocols is an object");

    assert_eq!(
        protocols.len(),
        2,
        "two versions of one unit must be two entries, not one that replaced the other"
    );
    assert!(protocols.contains_key("git.status@v1"));
    assert!(protocols.contains_key("git.status@v2"));
    assert_eq!(protocols["git.status@v1"]["version"], 1);
    assert_eq!(protocols["git.status@v2"]["version"], 2);
}

#[test]
fn the_bare_id_selects_every_version_of_that_unit() {
    // `just protocol-schema git.status` has to keep meaning what it always
    // meant now that a unit can have more than one generation. The qualified
    // key is the narrower question, for a reader who wants one generation.
    let base = units()
        .into_iter()
        .find(|u| u.id == "git.status")
        .expect("git.status is declared");
    let mut v2 = base.clone();
    v2.version = 2;

    let both = crate::schema::document_of(&[base.clone(), v2.clone()], Some("git.status"));
    assert_eq!(both["protocols"].as_object().unwrap().len(), 2);

    let one = crate::schema::document_of(&[base, v2], Some("git.status@v2"));
    assert_eq!(one["protocols"].as_object().unwrap().len(), 1);
    assert!(one["protocols"]["git.status@v2"].is_object());
}

#[test]
fn every_reference_in_the_document_resolves() {
    // The JSON Schema half of what `every_unit_file_is_self_contained` checks
    // for TypeScript: a `$ref` with no matching `$defs` entry is a broken
    // document, and a consumer would discover it at validation time rather than
    // here. Every document shipped by the tool is checked, since the filtered
    // one carries a different definition set than the whole.
    for only in [None, Some("agent.session.create"), Some("git.status")] {
        let doc = crate::schema::document(only);
        let defs: BTreeSet<&str> = doc["$defs"]
            .as_object()
            .expect("$defs is an object")
            .keys()
            .map(String::as_str)
            .collect();

        let mut refs = BTreeSet::new();
        collect_refs(&doc["protocols"], &mut refs);

        for r in refs {
            let name = r
                .strip_prefix("#/$defs/")
                .unwrap_or_else(|| panic!("{only:?}: `{r}` is not a local definition reference"));
            assert!(
                defs.contains(name),
                "{only:?}: `{r}` is referenced but not defined"
            );
        }
    }
}

#[test]
fn one_operation_carries_only_its_own_definitions() {
    // The point of the filter: a reader of one operation should not have to
    // wade through the whole catalog's types to find the four it uses.
    let whole = crate::schema::document(None);
    let one = crate::schema::document(Some("agent.session.create"));

    let count = |d: &serde_json::Value| d["$defs"].as_object().unwrap().len();
    assert!(
        count(&one) < count(&whole),
        "the filtered document carries as many definitions as the whole catalog"
    );
    assert_eq!(one["protocols"].as_object().unwrap().len(), 1);
    assert!(
        count(&one) > 0,
        "a unit with shapes should carry the definitions they reference"
    );
}

#[test]
fn an_unknown_operation_is_an_empty_catalog_rather_than_an_error() {
    // Asking about a unit that does not exist is a question, and the answer is
    // that there is no such unit — not a failure of the tool. The document
    // still parses, so a caller can tell the two apart.
    let doc = crate::schema::document(Some("no.such.operation"));
    assert!(doc["protocols"].as_object().unwrap().is_empty());
    assert_eq!(
        doc["$schema"],
        "https://json-schema.org/draft/2020-12/schema"
    );
}

#[test]
fn a_unit_with_no_shape_says_so_instead_of_omitting_the_key() {
    // Present and null, so a consumer can tell "no shape" from "this document
    // predates the field" — the same rule the agent-list wire follows.
    //
    // The subject is named now, and it is a *stable* one rather than whichever
    // unit happened to be untyped. This test used to pick "whatever identity-only
    // unit is left" and panic when there was none — it went red with
    // `#920 finished: no identity-only units remain`, which is how the end of
    // that work was detected. With nothing left to trip, a name is clearer.
    //
    // `server.agent.session-update` is one-way **permanently**: the agent
    // reports one session's state and nothing answers — all five exits of
    // `handle_agent_session_update` are `Reply(None)`. It cannot be typed out
    // of this test the way `server.env.write` was.
    //
    // The subject moved here from `agent.keepalive.ping`, which is no longer a
    // unit at all: it is `control.ping`, and control wires are not units, so
    // there is no entry for this test to read. The premise (`response: None`)
    // is unchanged; only the name it is read off.
    let doc = crate::schema::document(None);
    let unit = units()
        .into_iter()
        .find(|u| u.id == "server.agent.session-update")
        .expect("server.agent.session-update is declared");
    assert!(
        unit.response.is_none(),
        "the premise moved: server.agent.session-update answers now, so this test needs a new subject"
    );
    let entry = &doc["protocols"][protocol_key(&unit)];
    assert!(entry["request"].is_object(), "{} has no request", unit.id);
    assert!(entry["response"].is_null(), "{} has a response", unit.id);
    assert_eq!(entry["owner"], unit.owner);
    assert_eq!(entry["version"], unit.version);
}
