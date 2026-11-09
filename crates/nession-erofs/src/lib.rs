//! Nession's deterministic EROFS build and content-addressed blob layer
//! (#3022).
//!
//! The Server owns image metadata, bytes and authorization. This crate owns the
//! mechanics that make the bytes reproducible: a controlled, shallow Git
//! snapshot; a fixed `mkfs.erofs` argv; a digest-addressed atomic blob store.
//! It never executes repository code and it never mints or accepts a
//! credential.

pub mod build;
pub mod git;
pub mod store;

pub use build::{BuiltImage, ErofsBuilder, MkfsRunner, ProcessMkfsRunner};
pub use git::{GitCommandRunner, GitSnapshot, GitTarget, ProcessGitRunner};
pub use store::{BlobDigest, BlobStore};
