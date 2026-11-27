//! `nession profile credential set|clear <name>` leaf handlers.
//!
//! Secrets arrive only through a masked terminal prompt or one line of stdin
//! (`--stdin`) — never as argv. Output, errors and the profile TOML stay
//! secret-free; the bytes live in [`crate::profile::credential`].

pub mod clear;
pub mod set;
