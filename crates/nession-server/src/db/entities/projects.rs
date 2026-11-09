//! SeaORM entity for the `projects` table (#3021).
//!
//! A Project is a server-owned declaration. Its optional Git source, Existing
//! Locations and Session defaults are stored as JSON: the Server is the only
//! writer and reader, and the API's canonical validation rejects anything that
//! could not have been written through it.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "projects")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub project_id: String,
    pub name: String,
    pub description: Option<String>,
    /// JSON-encoded `ProjectSource`.
    pub source_json: Option<String>,
    /// JSON-encoded `Vec<ProjectLocation>`; `[]` when the Project has none.
    pub locations_json: String,
    /// JSON-encoded `ProjectSessionDefaults`.
    pub session_defaults_json: Option<String>,
    /// Immutable reference to an EROFS artifact; the blob is not owned here.
    pub image_digest: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
