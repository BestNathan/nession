//! The Sandbox policy family (#2681).
//!
//! `sandbox` is a contract family without a wire of its own: the policy rides
//! the session create payloads, and its version selects the schema generation
//! exactly as a protocol unit's contract version does.

pub mod v1;
