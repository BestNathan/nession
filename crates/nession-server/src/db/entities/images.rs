//! SeaORM entity for the `images` table (#3022).

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "images")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub image_id: String,
    /// `sha256:<64 lowercase hex>` once ready; NULL while building or failed.
    pub digest: Option<String>,
    pub size_bytes: i64,
    /// Canonical JSON of the normalized source.
    pub source_json: String,
    /// The exact resolved Git commit; NULL for a local-directory source.
    pub source_sha: Option<String>,
    /// Canonical JSON of the packaging parameters.
    pub packaging_json: String,
    /// `building`, `ready` or `failed`.
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
