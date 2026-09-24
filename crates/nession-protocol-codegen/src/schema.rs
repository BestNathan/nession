//! The catalog as a JSON Schema document.
//!
//! The same contracts the TypeScript generator reads, projected a second way:
//! [`crate::lib`] emits shapes a consumer *imports*, this emits shapes a
//! consumer *validates against*. Both come from the one Rust type per contract,
//! so neither can describe a protocol the other does not.
//!
//! A unit's `$defs` are shared rather than per-protocol. Two operations that
//! mention `EnvSnapshot` must point at one definition; separate generators
//! would emit it twice and a reader comparing the two documents would find
//! them unrelated.

use schemars::SchemaGenerator;
use serde_json::{json, Map, Value};

use crate::catalog::{units, Alias, Unit};

/// The draft this document declares itself against.
const DRAFT: &str = "https://json-schema.org/draft/2020-12/schema";

/// The whole catalog, or one protocol, as a JSON Schema document.
///
/// `only` filters on the canonical id, or on one version of it. It is one
/// document either way, with the same shape: the filtered form carries the
/// `$defs` that operation references and nothing else, so reading a single
/// protocol costs a reader no more than that protocol needs.
///
/// An unknown `only` yields a document with no protocols rather than an error —
/// the caller asked a question about a catalog, and "no such unit" is the
/// answer to it, not a failure of the tool.
#[must_use]
pub fn document(only: Option<&str>) -> Value {
    document_of(&units(&crate::config()), only)
}

/// The same document, over a catalog given explicitly.
///
/// Separate from [`document`] so a test can describe a catalog this build does
/// not serve. That is not a convenience: no shipped contract has a second
/// version yet, so a two-version catalog is the *only* way to check that both
/// survive — and the failure being checked for is one where nothing errors and
/// a contract simply is not there.
#[must_use]
pub fn document_of(catalog: &[Unit], only: Option<&str>) -> Value {
    let mut gen = SchemaGenerator::default();
    let mut protocols = Map::new();

    for unit in catalog {
        if !selected(unit, only) {
            continue;
        }
        protocols.insert(entry_key(unit), entry(unit, &mut gen));
    }

    let mut doc = Map::new();
    doc.insert("$schema".into(), json!(DRAFT));
    doc.insert("title".into(), json!("Nession protocol catalog"));
    doc.insert("protocols".into(), Value::Object(protocols));
    // Read *after* every unit has contributed, so a shape reached through any
    // operation is defined once for all of them.
    doc.insert("$defs".into(), Value::Object(gen.definitions().clone()));
    Value::Object(doc)
}

/// The key one `(Protocol Unit, Contract Version)` takes under `protocols`.
///
/// `(id, version)`, never the id alone. Keying by id meant a second version of a
/// Unit **overwrote** the first: `Map::insert` replaces, nothing failed, and one
/// contract simply was not in the document — the silent-loss shape `#963` is
/// about. A JSON document cannot raise on a duplicate key, so the key has to
/// carry the version rather than the writer having to remember to check.
///
/// The version is spelled into the name for the same reason it is a path segment
/// in the generated TypeScript (`lib.rs`): a reader cannot forget which
/// generation a shape belongs to if the name will not let them.
fn entry_key(unit: &Unit) -> String {
    format!("{}@v{}", unit.id, unit.version)
}

/// Whether `only` asks for this unit.
///
/// The bare id selects **every** version of it, because that is the question a
/// reader asking about `git.status` is asking. The version-qualified key selects
/// one generation. Accepting both is what keeps
/// `just protocol-schema git.status` meaning what it has always meant.
fn selected(unit: &Unit, only: Option<&str>) -> bool {
    match only {
        None => true,
        Some(want) => want == unit.id || want == entry_key(unit),
    }
}

/// One protocol's entry: who owns it, which version, which wires, and the two
/// halves of its operation surface.
fn entry(unit: &Unit, gen: &mut SchemaGenerator) -> Value {
    let mut e = Map::new();
    e.insert("owner".into(), json!(unit.owner));
    e.insert("version".into(), json!(unit.version));
    e.insert("wires".into(), json!(unit.wires));
    e.insert("request".into(), half(unit.request, gen));
    e.insert("response".into(), half(unit.response, gen));
    Value::Object(e)
}

/// One half of a unit's operation surface.
///
/// `null` rather than an absent key when the unit has no such half — the same
/// rule the agent-list wire uses, and for the same reason: a consumer reading
/// `request` gets a definite answer for every protocol rather than having to
/// tell "no request" apart from "this document is older than the field".
fn half(alias: Option<Alias>, gen: &mut SchemaGenerator) -> Value {
    match alias {
        Some((name, _typescript, schema)) => json!({
            "alias": name,
            "shape": schema(gen),
        }),
        None => Value::Null,
    }
}
