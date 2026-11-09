//! Single harness for `nession-mcp` integration tests.
//!
//! The target is named `integration` so the repository's
//! `rust-test-integration` Gate (`cargo test --workspace --test integration`)
//! owns these tests, alongside every other crate's real-stack suite.

mod standalone;
