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
/// `only` filters on the canonical id. It is one document either way, with the
/// same shape: the filtered form carries the `$defs` that operation references
/// and nothing else, so reading a single protocol costs a reader no more than
/// that protocol needs.
///
/// An unknown `only` yields a document with no protocols rather than an error —
/// the caller asked a question about a catalog, and "no such unit" is the
/// answer to it, not a failure of the tool.
#[must_use]
pub fn document(only: Option<&str>) -> Value {
    let mut gen = SchemaGenerator::default();
    let mut protocols = Map::new();

    for unit in units(&crate::config()) {
        if only.is_some_and(|want| want != unit.id) {
            continue;
        }
        protocols.insert(unit.id.to_string(), entry(&unit, &mut gen));
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
