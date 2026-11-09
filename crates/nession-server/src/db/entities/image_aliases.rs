//! SeaORM entity for the `image_aliases` table (#3022).

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "image_aliases")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub alias: String,
    pub image_digest: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
