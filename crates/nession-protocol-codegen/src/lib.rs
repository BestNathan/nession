//! Generates the Web's TypeScript bindings from the Rust contracts (`#678`).
//!
//! ## What this owns, and what ts-rs owns
//!
//! ts-rs answers "what TypeScript shape is this Rust type?". Everything else is
//! here: which types belong to which contract, where the file goes, what the
//! unit's identity constants are, and what the request and response aliases are
//! called. That division is deliberate — a generator that also owned the type
//! translation would be a second, worse `ts-rs`, and one that let ts-rs own the
//! layout would produce one file per type with imports, which is not the layout
//! the design asks for:
//!
//! ```text
//! web/src/generated/protocol/<owner>/<unit>/v<N>.ts
//! ```
//!
//! ## One file per unit, self-contained, and no barrel
//!
//! No imports between generated files. A unit's file carries every type it
//! mentions, so a reader can answer "what does `git.status` look like?" by
//! opening one file, and a consumer can copy one file into a test. The
//! duplicate declarations that costs are generated, so they cannot disagree.
//! [`check_self_contained`] proves it rather than assuming it, using ts-rs's
//! own dependency data.
//!
//! **There is deliberately no `index.ts`.** The first version had one, and
//! `tsc` refused it: every unit exports `PROTOCOL`, `WIRE` and `VERSION`, and
//! six git units all export `SessionTargetV1`, so a barrel is a wall of
//! `TS2308` ambiguity errors. The fix is not to rename the constants — it is to
//! delete the barrel, because the thing a barrel would buy is the thing this
//! whole issue is against: importing a shape without saying which contract
//! version it is. A consumer writes
//!
//! ```text
//! import { StatusResponse } from '@/generated/protocol/git/status/v1';
//! ```
//!
//! and the version is in the path, where it cannot be forgotten.
//!
//! ## Deterministic, and replaced wholesale
//!
//! The output directory is deleted and rewritten, so a contract that is removed
//! takes its file with it — a stale generated file is a contract the Web would
//! keep compiling against. File order, field order and formatting all come from
//! the catalog and ts-rs, both of which are stable, and the gate is
//! `git diff --exit-code` after regenerating.

//! ## Library and binary, because of where tests run
//!
//! The logic is here rather than in `main.rs` so the checks below are covered
//! by `just test-unit`, which is `cargo test --workspace --lib`. A binary
//! crate's unit tests are a `--bins` target, which that filter does not select —
//! so a generator written as a single `main.rs` would have its catalog checks
//! silently skipped by every gate in the repository while passing when run by
//! hand. `main.rs` is the argument parsing, and nothing else.

pub mod catalog;

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use catalog::Unit;
use ts_rs::Config;

/// Where the bindings go, relative to the repository root.
pub const DEFAULT_OUT: &str = "web/src/generated/protocol";

/// Write every contract's bindings under `out`, returning how many were written.
pub fn run(out: &Path) -> Result<usize, String> {
    let cfg = config();
    let units = catalog::units(&cfg);

    // Before anything is written. A file that refers to a name it does not
    // declare is a `tsc` error at the consumer, three layers from the Rust that
    // caused it — and a generator that can emit one should refuse instead. The
    // same check runs as a test, which is where it is normally read; here it is
    // also the reason a `just codegen` run cannot leave a broken tree behind.
    check_self_contained(&units, &cfg)?;
    check_paths_are_unique(&units)?;

    // Wholesale, not incremental. A contract removed from the catalog must take
    // its file with it, and an incremental writer would leave it behind for the
    // Web to keep importing.
    if out.exists() {
        std::fs::remove_dir_all(out).map_err(|e| e.to_string())?;
    }

    for unit in &units {
        let path = out.join(unit_path(unit));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, render(unit, &cfg)).map_err(|e| e.to_string())?;
    }

    Ok(units.len())
}

/// Every name a declaration refers to is declared by the same unit.
///
/// Generated files carry no imports, so this is what makes one readable on its
/// own. ts-rs already knows every name a declaration refers to, which makes the
/// check exact rather than a scan for identifiers that look like types.
pub fn check_self_contained(units: &[Unit], cfg: &Config) -> Result<(), String> {
    for unit in units {
        let declared: Vec<&str> = unit.decls.iter().map(|d| d.name.as_str()).collect();
        for decl in &unit.decls {
            for dep in (decl.deps)(cfg) {
                if !declared.contains(&dep.ts_name.as_str()) {
                    return Err(format!(
                        "`{}` refers to `{}`, which it does not declare — \
                         add it to the catalog in crates/nession-protocol-codegen/src/catalog.rs",
                        unit.id, dep.ts_name
                    ));
                }
            }
        }
    }
    Ok(())
}

/// No two units write to the same file.
///
/// The path is derived from the id ([`operation`]), and the kernel's ids span
/// families — so the derivation is doing real work and can be got wrong. Two
/// units landing on one path would not fail anything: the second write would
/// simply replace the first, and the Web would import a contract that is not
/// the one it asked for. Silent, and in the one artefact nobody reads.
pub fn check_paths_are_unique(units: &[Unit]) -> Result<(), String> {
    let mut seen: std::collections::BTreeMap<PathBuf, &str> = std::collections::BTreeMap::new();
    for unit in units {
        let path = unit_path(unit);
        if let Some(first) = seen.insert(path.clone(), unit.id) {
            return Err(format!(
                "`{}` and `{}` both generate to {} — two contracts cannot share a file",
                first,
                unit.id,
                path.display()
            ));
        }
    }
    Ok(())
}

/// `git/status/v1.ts` — the owner, the unit's operation, the contract version.
///
/// The version is a path segment rather than a suffix so that two versions can
/// be imported without either being the "default" one — which is the whole
/// point of versioning them.
fn unit_path(unit: &Unit) -> PathBuf {
    Path::new(unit.owner)
        .join(operation(unit))
        .join(format!("v{}.ts", unit.version))
}

/// The unit's directory segment: its id with the owner's prefix removed.
///
/// One rule, and it covers both halves without a special case. For a provider
/// the prefix *is* the owner — `git.status` under `git` is `status`, and
/// `claude-code.read` under `claude-code` is `read`. The kernel's units have no
/// such prefix: `server.session.create` and `agent.session.create` are both the
/// kernel's, so they keep their whole id — which is also what keeps them apart,
/// since both would otherwise end in `create`, as would `agent.attach` and
/// `server.session.attach` in `attach`.
///
/// Dots become dashes because the segment is a directory name.
fn operation(unit: &Unit) -> String {
    let prefix = format!("{}.", unit.owner);
    unit.id
        .strip_prefix(&prefix)
        .unwrap_or(unit.id)
        .replace('.', "-")
}

/// The one `Config`, so every file in one run is generated under the same rules.
///
/// `with_large_int("number")` is not a preference. ts-rs defaults to `bigint`,
/// which is right for a binary protocol and wrong for this one: every `u64`
/// here arrives through `JSON.parse` as a `number`, so a `bigint` annotation
/// would describe a value the runtime never produces. The design requires the
/// number range to be explicit, and this is where it is.
pub fn config() -> Config {
    Config::new().with_large_int("number")
}

/// The catalog as this build composes it.
pub fn units() -> Vec<Unit> {
    catalog::units(&config())
}

fn render(unit: &Unit, cfg: &Config) -> String {
    let mut out = String::new();
    header(&mut out, &format!("{} / v{}", unit.id, unit.version));

    let _ = writeln!(out, "/** The canonical protocol id. Not the wire type. */");
    let _ = writeln!(out, "export const PROTOCOL = '{}';", unit.id);
    let _ = writeln!(
        out,
        "/** Every transport projection this contract travels as. */"
    );
    let _ = writeln!(
        out,
        "export const WIRES = [{}] as const;",
        unit.wires
            .iter()
            .map(|w| format!("'{w}'"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    if let [only] = unit.wires {
        let _ = writeln!(
            out,
            "/**\n * The only projection this contract travels as.\n *\n * Absent, deliberately, on a contract served over more than one transport: it\n * has no single wire, and a caller that needs one has to say which it means.\n * `WIRES` is always there.\n */"
        );
        let _ = writeln!(out, "export const WIRE = '{only}';");
    }
    let _ = writeln!(out, "/** The contract version these shapes are. */");
    let _ = writeln!(out, "export const VERSION = {};", unit.version);

    let _ = writeln!(out, "\n// ── Shapes ──\n");
    for decl in &unit.decls {
        let _ = writeln!(out, "export {}", (decl.render)(cfg));
    }

    let _ = writeln!(out, "\n// ── Operations ──\n");
    // Absent, not empty. A half with no shape gets no alias — an alias over a
    // made-up shape would be worse than none, and a consumer importing the
    // missing one should be told it does not exist rather than handed an empty
    // object that typechecks.
    //
    // The comment says only what this generator knows, which is less than it
    // looks. It cannot tell a unit that is genuinely one-way from one whose
    // kernel contract simply declares no shape for that half, and it must not
    // guess: four of the kernel's list calls have no request type at all — the
    // Web sends `{}` — and a generator that labelled those "an event a provider
    // sends, with nothing to ask for" would be writing a falsehood into the one
    // artefact nobody reads closely.
    //
    // The two `Some` arms keep distinct prose. They were once the same string,
    // which made every generated response comment say "the payload a caller
    // sends".
    for (label, alias, what) in [
        ("request", &unit.request, "The payload a caller sends."),
        (
            "response",
            &unit.response,
            "The payload the provider answers with.",
        ),
    ] {
        match alias {
            Some((name, shape)) => {
                let _ = writeln!(out, "/** {what} */");
                let _ = writeln!(out, "export type {name} = {};", shape(cfg));
                let _ = writeln!(out);
            }
            None => {
                let _ = writeln!(
                    out,
                    "/**\n * No {label} alias: the catalog declares no {label} shape for this unit.\n */"
                );
            }
        }
    }
    out
}

fn header(out: &mut String, what: &str) {
    let _ = writeln!(
        out,
        "// Generated by `just codegen` — do not edit.\n\
         //\n\
         // Source of truth: the Rust contracts in `crates/nession-git/src/protocol/`,\n\
         // `crates/nession-claude-code/src/protocol/` and `crates/nession-protocol/`.\n\
         // This file is {what}.\n"
    );
}

#[cfg(test)]
mod tests;
