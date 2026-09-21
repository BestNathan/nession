//! The contract fixtures (`#875`).
//!
//! ## What the tests in this directory could not do
//!
//! Every `tests.rs` beside a contract asserts a round trip or reads a
//! hand-written `json!` literal. Both prove the type is self-consistent. Neither
//! proves the *bytes* are what a peer sends, which is the only thing a wire
//! contract claims — a renamed field, a `rename` written wrong, or a key that a
//! real client sends and this struct never modelled all round-trip perfectly.
//!
//! A fixture is a payload written down **as bytes**, read back by the test
//! rather than constructed from the type. The difference is where the shape
//! comes from: a test that builds `FileReadPayload { .. }` and serialises it is
//! asking the type what it looks like, and it will agree with itself forever.
//!
//! ## Every fixture here is reconstructed, and says so
//!
//! None was captured from a running system. There is no path that exports a
//! payload, and building one is a larger piece than this — so each fixture was
//! rebuilt from the shape the code carried at a named revision, and
//! [`Origin::Reconstructed`] carries that revision. This is the weaker of the
//! two claims and it is the one written down: a reader who takes these for
//! captured bytes would be taking them for evidence they are not.
//!
//! What reconstruction still buys is real. The bytes are fixed at a point in
//! time, so a contract that changes shape has to change *against a file*, and
//! the diff that does it is in the review. A round-trip test has no such moment.
//!
//! ## Why the table is here and the bytes are beside the contract
//!
//! Payloads live in `<family>/fixtures/`, next to the contract they are evidence
//! about — a fixture two directories from its contract is one that can be
//! changed without the contract being read.
//!
//! The table is in one place because it has to be *complete*: a test below
//! asserts that every file on disk is declared and every declaration has a file.
//! Declaring provenance in the filename instead would mean parsing it back out
//! to check anything, and the two directions are what stop a fixture being
//! quietly orphaned.

#![cfg(test)]

use std::path::PathBuf;

/// Where one fixture came from.
///
/// One variant, because one variant is the truth: nothing here was read off a
/// running system. A `Captured` variant would be a place to say so — and it
/// would also be dead code the compiler is right to complain about, since no
/// fixture could use it. It goes in with the first captured fixture, which is
/// the only moment it would mean anything.
pub(crate) enum Origin {
    /// Rebuilt from the shape the code carried at the named revision.
    ///
    /// The revision is the point of it: "reconstructed" without saying from
    /// what is a claim nobody can check.
    Reconstructed(&'static str),
}

impl Origin {
    fn describe(&self) -> String {
        match self {
            Origin::Reconstructed(revision) => format!("reconstructed from {revision}"),
        }
    }
}

/// One payload, written down as bytes.
pub(crate) struct Fixture {
    /// The contract family it belongs to — the directory in `contracts/`.
    pub family: &'static str,
    /// The file under that family's `fixtures/`.
    pub file: &'static str,
    /// The wire message type it travels as.
    pub wire: &'static str,
    /// Whether a peer sent it, or it is sent to a peer.
    pub direction: &'static str,
    pub origin: Origin,
    /// What this fixture is here to pin, in one line. A fixture whose `pins` is
    /// vague is one nobody will dare delete.
    pub pins: &'static str,
}

impl Fixture {
    fn path(&self) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src/contracts")
            .join(self.family)
            .join("fixtures")
            .join(self.file)
    }

    /// The payload's bytes, verbatim. Panics with the path, because a fixture
    /// that moved is a test that stopped testing (`#875`, and the same failure
    /// `e2e/fixtures` was fixed for).
    pub fn bytes(&self) -> String {
        let path = self.path();
        std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "fixture `{}` is not readable at {}: {e}",
                self.file,
                path.display()
            )
        })
    }

    /// The payload, decoded into the contract type.
    pub fn decode<T: serde::de::DeserializeOwned>(&self) -> T {
        serde_json::from_str(&self.bytes()).unwrap_or_else(|e| {
            panic!(
                "fixture `{}` does not decode into {} — {} ({})",
                self.file,
                std::any::type_name::<T>(),
                e,
                self.origin.describe()
            )
        })
    }
}

/// Every fixture in this tree.
pub(crate) const FIXTURES: &[Fixture] = &[
    Fixture {
        family: "agent",
        file: "register-legacy-no-manifest.json",
        wire: "agent.register",
        direction: "agent -> server",
        origin: Origin::Reconstructed(
            "`AgentRegisterPayload` before #678 added `protocol_manifest`",
        ),
        pins: "the registration an agent that predates manifests sends, and the \
               reason `protocol_manifest` is `Option`: it must decode, because the \
               server's refusal for it is a *decision*, not a parse error",
    },
    Fixture {
        family: "file",
        file: "read-window-absent.json",
        wire: "file.read",
        direction: "consumer -> provider",
        origin: Origin::Reconstructed("`FileReadPayload` before #750 added offset/limit"),
        pins: "the whole-file read: neither key present. Absent, not null — the \
               distinction #750's truncation notice reads",
    },
    Fixture {
        family: "file",
        file: "read-window-explicit-null.json",
        wire: "file.read",
        direction: "consumer -> provider",
        origin: Origin::Reconstructed("a client that serialised its own `Option`s without skip"),
        pins: "the same request with both keys *present and null*. Decodes to the \
               same value as the absent one — which is why the distinction has to \
               live on the way out, not on the way in",
    },
    Fixture {
        family: "file",
        file: "read-window-chunked.json",
        wire: "file.read",
        direction: "consumer -> provider",
        origin: Origin::Reconstructed("the windowed read #750 introduced"),
        pins: "a non-zero offset: the number range the design requires be explicit, \
               and the one place a `u64` could have been a `bigint`",
    },
    Fixture {
        family: "file",
        file: "delete-legacy-no-recursive.json",
        wire: "file.delete",
        direction: "consumer -> provider",
        origin: Origin::Reconstructed("`FileDeletePayload` before `recursive` existed"),
        pins: "that an absent `recursive` means the old, empty-directory-only \
               behaviour — a *behaviour* default, not a formatting one",
    },
    Fixture {
        family: "server",
        file: "info-with-manifest.json",
        wire: "client.server.info",
        direction: "server -> consumer",
        origin: Origin::Reconstructed("the `client.server.info` answer #678 Phase 6b added"),
        pins: "that `protocol_manifest` decodes as the server actually sends it — \
               a map of unit id to `{versions, wire}`, not an array",
    },
];

/// Read a fixture by file name, or say which names exist.
pub(crate) fn fixture(file: &str) -> &'static Fixture {
    FIXTURES.iter().find(|f| f.file == file).unwrap_or_else(|| {
        let names: Vec<&str> = FIXTURES.iter().map(|f| f.file).collect();
        panic!("no fixture named `{file}`; declared: {names:?}")
    })
}

/// Every `*.json` under any family's `fixtures/`, as `(family, file)`.
fn files_on_disk() -> Vec<(String, String)> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/contracts");
    let mut found = Vec::new();
    let families = std::fs::read_dir(&root).expect("the contracts directory is readable");
    for family in families {
        let dir = family.expect("readable entry").path().join("fixtures");
        if !dir.is_dir() {
            continue;
        }
        let family_name = dir
            .parent()
            .and_then(|p| p.file_name())
            .expect("a fixtures dir has a parent")
            .to_string_lossy()
            .to_string();
        for entry in std::fs::read_dir(&dir).expect("the fixtures directory is readable") {
            let path = entry.expect("readable entry").path();
            if path.extension().is_some_and(|e| e == "json") {
                found.push((
                    family_name.clone(),
                    path.file_name()
                        .expect("a file has a name")
                        .to_string_lossy()
                        .to_string(),
                ));
            }
        }
    }
    found.sort();
    found
}

#[test]
fn every_file_on_disk_is_declared() {
    // The direction that catches an orphan. A fixture added and not declared is
    // a payload nothing reads — it would sit there looking like evidence while
    // asserting nothing, which is worse than not having it.
    let declared: Vec<(String, String)> = FIXTURES
        .iter()
        .map(|f| (f.family.to_string(), f.file.to_string()))
        .collect();
    let on_disk = files_on_disk();

    for entry in &on_disk {
        assert!(
            declared.contains(entry),
            "{} is on disk but not in FIXTURES — nothing reads it",
            entry.1
        );
    }
}

#[test]
fn every_declaration_has_a_file() {
    // And the direction that catches a rename. `Fixture::bytes` panics on a
    // missing file, so a test that reads one would fail — but only if a test
    // reads it, and a declared-but-unread fixture is exactly the one that
    // would not be.
    let on_disk = files_on_disk();
    for f in FIXTURES {
        assert!(
            on_disk.contains(&(f.family.to_string(), f.file.to_string())),
            "`{}` is declared but there is no file at {}",
            f.file,
            f.path().display()
        );
    }
}

#[test]
fn every_declaration_says_where_it_came_from_and_what_it_pins() {
    // `pins` is the field that decides whether a future reader may delete the
    // fixture, so an empty one is a fixture nobody can safely touch.
    for f in FIXTURES {
        assert!(!f.pins.trim().is_empty(), "{} pins nothing", f.file);
        assert!(!f.wire.is_empty(), "{} names no wire", f.file);
        assert!(!f.direction.is_empty(), "{} names no direction", f.file);
    }
}
