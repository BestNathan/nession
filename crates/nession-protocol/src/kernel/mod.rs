//! The Protocol Kernel: the mechanism every Protocol Unit is expressed in.
//!
//! The Kernel evolves by **convergence** — its shape settles and stays, because
//! every unit depends on it. Protocol Units evolve by **succession** — new
//! versions are added beside old ones rather than editing them.
//!
//! The direction is one-way, and it is the dependency rule this crate exists to
//! enforce:
//!
//! ```text
//! Protocol Unit  ──▶  Protocol Kernel
//! Protocol Kernel ──✗──▶ concrete Protocol Unit
//! ```
//!
//! Nothing here names a concrete protocol: no `git`, no `claude-code`, no
//! session or terminal. `nession-protocol`'s dependency list is short because
//! that is the rule made mechanical rather than a note in a document.
//!
//! ## The modules
//!
//! - [`identity`] — what a protocol and a contract version *are*, and what
//!   makes a string a canonical one.
//! - [`envelope`] — the single message framing every transport shares.
//! - [`descriptor`] — what a unit declares about itself, in code.
//! - [`manifest`] — what a runtime actually offers, derived from what it
//!   composed.
//! - [`resolver`] — consumer requirements against a manifest, per unit.
//! - [`error`] — what resolution can refuse.

pub mod descriptor;
pub mod envelope;
pub mod error;
pub mod identity;
pub mod manifest;
pub mod resolver;

pub use descriptor::{ContractDescriptor, DescriptorError, Lifecycle, ProtocolDescriptor};
pub use envelope::{Message, ProtocolMessage};
pub use error::ProtocolError;
pub use identity::{ContractVersion, IdentityError, ProtocolId, MAX_ID_LEN};
pub use manifest::{CompositionError, ContractSupport, ProtocolManifest};
pub use resolver::{resolve, select_version};
