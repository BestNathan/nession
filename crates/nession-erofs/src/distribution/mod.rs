//! Server→Agent object distribution (#3499).
//!
//! The Server grants an authorized route for one immutable object; the Agent
//! streams it through the accepted #3022/#3023 mechanics: authenticated
//! `Range` resume, bounded responses, single-flight per digest, SHA-256
//! verification and atomic publication. EROFS payloads, Index/Manifest/Config
//! metadata and migration objects all use this one transfer engine; there is
//! no second download implementation in a consumer crate.
//!
//! [`transfer::TransferEngine`] owns the transfer state machine. A runtime
//! adapter supplies paths, pins and the #3412 progress projection through
//! [`transfer::ProgressObserver`]; it does not re-implement range parsing,
//! verification or publication.

pub mod http;
pub mod transfer;

pub use http::{DownloadGrant, TransferClient, DEFAULT_MAX_OBJECT_BYTES};
pub use transfer::{ProgressObserver, TransferEngine, TransferOutcome, TransferSpec};
