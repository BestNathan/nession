//! Manifest-addressed image catalog (#3496).
//!
//! The catalog owns repository/tag/reference metadata, durable pins and GC
//! marks, while immutable bytes stay in the CAS. It does not open a database:
//! every operation receives the Server's SQLite connection or transaction, so
//! authorization and connection ownership remain with the Server and there is
//! no second registry state machine.

pub mod gc;
pub mod legacy;
pub mod pin;
pub mod reference;
pub mod repository;
pub mod sqlite;
pub mod tag;

pub use gc::{protected_digests, GcPolicy, GcReport};
pub use legacy::{
    legacy_manifest_digest, migrate_legacy_images, rollback_legacy_migration,
    LegacyMigrationReport, LegacyPlatform, LegacyRollbackReport, LEGACY_REPOSITORY,
};
pub use pin::{CatalogPin, ConsumerKind};
pub use reference::{ObjectKind, StoredObject};
pub use repository::{ensure_repository, validate_repository_name};
pub use sqlite::CATALOG_SCHEMA_VERSION;
pub use tag::{get_tag, set_tag, TagExpectation, TagUpdate};

use anyhow::Result;
use sea_orm::ConnectionTrait;

/// Create or verify the catalog schema in the Server's connection.
pub async fn migrate(conn: &impl ConnectionTrait) -> Result<()> {
    sqlite::migrate(conn).await
}
