//! The Nession Protocol Kernel (#678).
//!
//! Nession does not have one protocol version. It has a set of independently
//! evolving **Protocol Units**; each owns versioned **Contracts**; **Providers**
//! implement those contracts through evolving **Generations**; and runtimes
//! compose a concrete **Protocol Set** that a **Manifest** describes.
//!
//! ```text
//! Consumer ──▶ Contract ──▶ Provider ──▶ Generation
//! ```
//!
//! ## What this crate is
//!
//! The stable mechanism that model is expressed in — identity, framing,
//! descriptors, manifests, resolution — and nothing else. It is the layer that
//! every unit depends on and that depends on no unit.
//!
//! ## What this crate is not
//!
//! - **Not a central DTO repository.** A concrete provider owns its contracts
//!   and writes them next to the code that serves them, because the crate that
//!   implements a contract is the only place that can answer "what changed?"
//!   when the contract moves.
//! - **Not a runtime.** It has no registry of live handlers, no I/O and no
//!   async; the composition that turns descriptors into a served protocol set
//!   belongs to the runtime that composes them.
//! - **Not the Product Capability model.** A Product Capability is a
//!   user-visible thing with a presence state; a Protocol Unit is a wire
//!   contract. The two may have the same name and are not the same concept.
//!
//! ## The dependency rule
//!
//! Protocol Unit → Protocol Kernel, and never back:
//!
//! ```text
//! Protocol Unit  ──▶  Protocol Kernel
//! Protocol Kernel ──✗──▶ concrete Protocol Unit
//! ```
//!
//! `Cargo.toml`'s dependency list is where that rule is enforced — this crate
//! has no path to `nession-common`, `nession-agent`, `nession-server`,
//! `nession-git` or `nession-claude-code`, so the Server's generic relay and
//! the resolver cannot come to depend on a concrete provider by accident.
//!
//! ## Where the code goes
//!
//! [`kernel`] holds the mechanism. [`contracts`] holds the core contracts —
//! the Protocol Units Nession itself owns, such as `session.attach` or
//! `agent.register` — one module per family, one file per contract version.
//! See `docs/architecture/protocol.md` for the layout rules and for how to add
//! a Protocol Unit, publish a new contract version, resolve one as a consumer,
//! generate consumer types and retire a contract.
//!
//! It used to name "provide a legacy adapter" among those. No such section
//! exists, and the design reaches the opposite conclusion: a peer with no
//! manifest is refused rather than guessed at, and the adapter was designed and
//! deliberately not built. A list of what the document contains should not
//! contain the thing the document exists to rule out.

pub mod contracts;
pub mod kernel;

// Flat re-exports for the handful of names almost every caller needs, so a
// contract module does not open with five `use crate::kernel::…` lines.
pub use kernel::{
    resolve, select_version, CompositionError, ContractDescriptor, ContractSupport,
    ContractVersion, DescriptorError, IdentityError, Lifecycle, Message, ProtocolDescriptor,
    ProtocolError, ProtocolId, ProtocolManifest, ProtocolMessage, MAX_ID_LEN,
};

/// The version of the Kernel's *own* mechanism — not of any protocol.
///
/// The design leaves open whether the kernel needs its own handshake version
/// (Open Question 4). It is named here as a constant so that question has one
/// place to be answered, and it is deliberately **not** consulted by
/// resolution: a kernel that negotiated its own compatibility through the same
/// path as contracts would recreate the global `protocol_version` this issue
/// exists to remove.
pub const KERNEL_MECHANISM_VERSION: u32 = 1;
