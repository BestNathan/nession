//! `git.status` — the repository's state as of one read.
//!
//! One module per Protocol Unit, one file per contract version. A v2 goes
//! beside `v1.rs`; `v1.rs` is never edited to express it.

pub mod v1;
pub mod v2;

pub use v1::{StatusOkV1, StatusRequestV1};
pub use v2::{StatusOkV2, StatusRequestV2};

use nession_protocol::{IdentityError, ProtocolDescriptor};

/// The protocol id, spelled once. A second spelling is a second protocol.
pub const ID: &str = "git.status";

/// The one wire both generations travel as.
pub const WIRE: &str = v1::WIRE;

/// v1 is the state; v2 adds the snapshot write operations are reviewed against.
///
/// Both generations ride this one wire; `contract_version` selects one.
/// Listed together here so a running provider advertises both and a v1-only
/// consumer still resolves v1 (`docs/architecture/protocol.md`).
pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    super::versioned_descriptor(ID, WIRE, &[1, 2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_generations_are_declared_on_the_one_wire() {
        let descriptor = descriptor().unwrap();
        assert_eq!(descriptor.id.as_str(), "git.status");
        assert_eq!(descriptor.owner, "nession-git");
        assert_eq!(
            descriptor.versions(),
            vec![
                nession_protocol::ContractVersion::new(1).unwrap(),
                nession_protocol::ContractVersion::new(2).unwrap()
            ]
        );
        for contract in &descriptor.contracts {
            assert_eq!(contract.wire, vec![WIRE.to_string()]);
        }
        assert!(descriptor.validate().is_ok());
    }
}
