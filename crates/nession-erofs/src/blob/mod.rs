//! Content-addressed byte identity and storage.
//!
//! [`digest`] is the single sha256 rule; [`store`] is the atomic, no-clobber
//! blob store shared by Index/Manifest/Config/EROFS objects (#3496).

pub mod digest;

#[cfg(feature = "store")]
pub mod store;
