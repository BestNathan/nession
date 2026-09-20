//! `terminal` contracts — see [`super`](self::super) for the layout rule.
//!
//! The terminal stream, as a browser speaks it to an agent directly.
//!
//! Three units are the whole of it: input goes down, output comes up, and a
//! resize is a message of its own because it is a different kind of fact — one
//! carries bytes the user typed, the other a fact about their window. Folding
//! them together would make "the user resized" and "the user typed" the same
//! message with a flag, and the two are handled by different things at the far
//! end.

pub mod v1;

#[cfg(test)]
mod tests;
