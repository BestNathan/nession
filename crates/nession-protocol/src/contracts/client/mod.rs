//! `client` contracts — see [`super`](self::super) for the layout rule.
//!
//! Authentication of a browser that connects to an agent directly.
//!
//! One unit, `client.auth`, and it exists because the peer-to-peer transport is
//! a second door into the same process: a browser that reaches an agent without
//! going through the server still has to say who it is, and this is where.

pub mod v1;

#[cfg(test)]
mod tests;
