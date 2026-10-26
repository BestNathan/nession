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
    let mut failures = Vec::new();
    for (index, line) in manifest.lines().enumerate() {
        let trimmed = line.trim();
        if !trimmed.starts_with("nession-") && !trimmed.starts_with("nession_") {
            continue;
        }
        // A bare key is a dependency entry (`nession-common.workspace = true`);
        // a comment or prose is not.
        if trimmed.starts_with('#') {
            continue;
        }
        failures.push(format!("Cargo.toml:{}: {}", index + 1, trimmed));
    }
    assert!(
        failures.is_empty(),
        "nession-tmux must not depend on a Nession crate:\n{}",
        failures.join("\n")
    );
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
            for (index, line) in text.lines().enumerate() {
                // Documentation may (and should) explain the boundary; only
                // code references matter.
                let code = line.split("//").next().unwrap_or("");
                if code.contains("nession_agent")
                    || code.contains("nession-agent")
                    || code.contains("nession_protocol")
                    || code.contains("nession-protocol")
                    || code.contains("nession_common")
                    || code.contains("nession-common")
                    || code.contains("nession_runtime")
                    || code.contains("nession-runtime")
                {
                    failures.push(format!("{}:{}: {}", path.display(), index + 1, line.trim()));
                }
            }
        });
    }
    assert!(
        failures.is_empty(),
        "nession-tmux source must not reference a Nession crate:\n{}",
        failures.join("\n")
    );
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
