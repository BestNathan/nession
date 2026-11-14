//! Migration m010 — the resolved Manifest identity of a Managed Session
//! (#3499).
//!
//! A Session created from a catalog image pins an immutable Manifest, not just
//! the EROFS blob digest. The binding records the final Manifest digest per
//! requested image so a restart or a later grant can prove which image
//! revision the Session actually resolved. The column is nullable: a binding
//! created through the historical digest-addressed path has no Manifest.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(SessionManagedContext::Table)
                    .add_column(
                        ColumnDef::new(SessionManagedContext::ResolvedImagesJson)
                            .text()
                            .null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(SessionManagedContext::Table)
                    .drop_column(SessionManagedContext::ResolvedImagesJson)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum SessionManagedContext {
    Table,
    ResolvedImagesJson,
}
