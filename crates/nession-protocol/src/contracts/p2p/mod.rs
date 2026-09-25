//! `p2p` contracts — see [`super`](self::super) for the layout rule.
//!
//! The credential that gates a direct Client → Agent connection.
//!
//! It exists because the peer-to-peer transport is a second door into the Agent
//! process, and until #1013 it was an unlocked one: the Server minted a token,
//! the Agent never checked it, and the socket behind it dispatches session
//! management and file operations as well as the terminal. The issuer is the
//! Server, the verifier is the Agent, and the unit here is how the record
//! travels between them.

pub mod v1;

#[cfg(test)]
mod tests;
