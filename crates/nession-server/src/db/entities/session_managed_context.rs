//! SeaORM entity for the `session_managed_context` table (#3062).

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "session_managed_context")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub session_id: String,
    pub agent_id: String,
    pub project_id: String,
    /// Fences concurrent creation attempts for one Session name.
    pub attempt_id: String,
    pub base_digest: String,
    pub workspace_digest: String,
    /// Canonical JSON of `[{digest, target}]`.
    pub toolchains_json: String,
    /// Resolved commit of the Project Source image, when it has one.
    pub source_sha: Option<String>,
    /// Agent-owned writable workspace directory, when the create reached it.
    pub workspace: Option<String>,
    /// `preparing`, `ready` or `failed`.
    pub status: String,
    pub error: Option<String>,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
