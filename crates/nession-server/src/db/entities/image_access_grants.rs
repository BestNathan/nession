//! SeaORM entity for the `image_access_grants` table (#3022).

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "image_access_grants")]
pub struct Model {
    /// SHA-256 of the bearer token; the token itself is never stored.
    #[sea_orm(primary_key, auto_increment = false)]
    pub token_hash: String,
    pub image_digest: String,
    /// Exactly one of `project_id` or `session_id` is set for a new grant.
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub expires_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
