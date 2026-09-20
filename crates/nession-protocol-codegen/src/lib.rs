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

/// `git/status/v1.ts` — the owner, the unit's operation, the contract version.
///
/// The version is a path segment rather than a suffix so that two versions can
/// be imported without either being the "default" one — which is the whole
/// point of versioning them.
fn unit_path(unit: &Unit) -> PathBuf {
    Path::new(unit.owner)
        .join(unit.id.rsplit('.').next().unwrap_or(unit.id))
        .join(format!("v{}.ts", unit.version))
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
        "/** The transport projection this contract travels as. */"
    );
    let _ = writeln!(out, "export const WIRE = '{}';", unit.wire);
    let _ = writeln!(out, "/** The contract version these shapes are. */");
    let _ = writeln!(out, "export const VERSION = {};", unit.version);

    let _ = writeln!(out, "\n// ── Shapes ──\n");
    for decl in &unit.decls {
        let _ = writeln!(out, "export {}", (decl.render)(cfg));
    }

    let _ = writeln!(out, "\n// ── Operations ──\n");
    let (request_name, request) = unit.request;
    let (response_name, response) = unit.response;
    let _ = writeln!(out, "/** The payload a caller sends. */");
    let _ = writeln!(out, "export type {request_name} = {};", request(cfg));
    let _ = writeln!(out, "\n/** The payload the provider answers with. */");
    let _ = writeln!(out, "export type {response_name} = {};", response(cfg));
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
