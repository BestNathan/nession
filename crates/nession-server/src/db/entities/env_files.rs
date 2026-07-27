//! SeaORM entity for the `env_files` table (issue #95, part 2).
//!
//! Stores server-managed `.env` files that were previously kept only on the
//! filesystem under `~/.nession/server/envs`. `name` (including the `.env`
//! suffix) is the primary key; writing an existing name overwrites it.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "env_files")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub name: String,
    /// Full `.env` file content (key=value lines).
    #[sea_orm(column_type = "Text")]
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
