//! The SDK must stay independent of Nession.
//!
//! A dependency on a Nession crate would make the library unusable outside the
//! workspace and would silently import Nession product semantics into the tmux
//! layer. This is a static check rather than a review habit: the failure is
//! invisible at the call site (the import alias looks like any other), so it is
//! proven here.

use std::path::{Path, PathBuf};

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Dependency sections are the only place a crate name can appear without the
/// code referencing it. `nession-tmux` itself is this crate and is not a
/// dependency.
#[test]
fn the_manifest_has_no_nession_dependency() {
    let manifest = std::fs::read_to_string(manifest_dir().join("Cargo.toml"))
        .expect("read the crate manifest");
    let failures = manifest_offenses(&manifest);
    assert!(
        failures.is_empty(),
        "nession-tmux must not depend on a Nession crate:\n{}",
        failures.join("\n")
    );
}

/// A Nession dependency entry is a bare crate name at the start of a manifest
/// line. A comment or prose naming one is documentation, not a dependency.
fn manifest_offenses(manifest: &str) -> Vec<String> {
    let mut failures = Vec::new();
    for (index, line) in manifest.lines().enumerate() {
        let trimmed = line.trim();
        if !trimmed.starts_with("nession-") && !trimmed.starts_with("nession_") {
            continue;
        }
        if trimmed.starts_with('#') {
            continue;
        }
        failures.push(format!("Cargo.toml:{}: {}", index + 1, trimmed));
    }
    failures
}

/// The scanner is the guard, so it gets its own planted fixture: a guard that
/// silently stopped matching would leave the positive test green over a clean
/// tree and prove nothing.
#[test]
fn the_manifest_guard_detects_a_planted_dependency() {
    let fixture = "[dependencies]\nnession-common.workspace = true\n# nession-agent is prose\n";
    assert_eq!(
        manifest_offenses(fixture),
        vec!["Cargo.toml:2: nession-common.workspace = true"]
    );
    assert!(manifest_offenses("[dependencies]\nanyhow.workspace = true\n").is_empty());
}

/// Source and integration tests must not name a Nession crate either. Test-only
/// dependencies are included by the manifest check above; this one catches a
/// fully-qualified path that survived a refactor.
#[test]
fn the_source_and_tests_name_no_nession_crate() {
    let root = manifest_dir();
    let mut failures = Vec::new();
    for directory in ["src", "tests"] {
        visit(&root.join(directory), &mut |path| {
            // This checker names the forbidden crates as data.
            if path.ends_with("tests/independence.rs") {
                return;
            }
            let text = std::fs::read_to_string(path).expect("read a source file");
            for line in source_offenses(&text) {
                failures.push(format!("{}:{line}", path.display()));
            }
        });
    }
    assert!(
        failures.is_empty(),
        "nession-tmux source must not reference a Nession crate:\n{}",
        failures.join("\n")
    );
}

/// Lines carrying a code reference to a Nession crate.
///
/// Documentation may (and should) explain the boundary; only a code reference
/// matters, so a `//` comment is not one. Both the hyphenated package name and
/// the underscored crate path are caught: an import uses the latter, a
/// `Cargo.toml` entry the former.
fn source_offenses(text: &str) -> Vec<usize> {
    const FORBIDDEN: [&str; 8] = [
        "nession_agent",
        "nession-agent",
        "nession_protocol",
        "nession-protocol",
        "nession_common",
        "nession-common",
        "nession_runtime",
        "nession-runtime",
    ];
    text.lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let code = line.split("//").next().unwrap_or("");
            FORBIDDEN
                .iter()
                .any(|name| code.contains(name))
                .then_some(index + 1)
        })
        .collect()
}

/// The source guard's own planted fixture, for the same reason as the manifest
/// guard's: a matcher that stopped matching must fail this test rather than
/// leave the tree looking independent.
#[test]
fn the_source_guard_detects_a_planted_reference() {
    let fixture = "use nession_agent::Server;\n// nession_agent in prose is fine\n\
                   let x = \"nession_protocol::Message\";\nlet ok = 1;\n";
    assert_eq!(source_offenses(fixture), vec![1, 3]);
    assert!(source_offenses("fn ok() { /* nothing */ }\n").is_empty());
}

fn visit(directory: &Path, check: &mut impl FnMut(&Path)) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            visit(&path, check);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            check(&path);
        }
    }
}
