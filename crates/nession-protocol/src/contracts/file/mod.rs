//! `file` contracts — see [`super`](self::super) for the layout rule.
//!
//! The file browser's operations, over the peer-to-peer transport.
//!
//! Every one is a path plus at most a modifier: `offset`/`limit` for a chunked
//! read, `recursive` for a delete. The shape is small on purpose — a file
//! browser that could ask for anything would be a shell, and the size of this
//! vocabulary is what keeps it one.
//!
//! `file.cwd` is the odd one: it takes a `session_id` rather than a path,
//! because "where is this session working" is a question about a session. It is
//! here rather than in `session` because what it *answers* with is a path, and
//! it is the file browser that asks.

pub mod v1;

#[cfg(test)]
mod tests;
