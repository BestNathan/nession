//! Migration m009 — image access grants name a Project or a Session (#3181).
//!
//! Access grants are ephemeral (five-minute default) bearer capabilities, not
//! durable references. Rebuilding the table is therefore safe: any in-flight
//! grant is re-requested by its consumer. The old table required every grant to
//! name a Project; a Sandbox/Session consumer needs a Session identity instead.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ImageAccessGrants::Table).to_owned())
            .await?;
        manager
            .create_table(
                Table::create()
                    .table(ImageAccessGrants::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ImageAccessGrants::TokenHash)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ImageAccessGrants::ImageDigest)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(ImageAccessGrants::ProjectId).string().null())
                    .col(ColumnDef::new(ImageAccessGrants::SessionId).string().null())
                    .col(
                        ColumnDef::new(ImageAccessGrants::ExpiresAt)
                            .big_integer()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_image_access_grants_digest")
                    .table(ImageAccessGrants::Table)
                    .col(ImageAccessGrants::ImageDigest)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ImageAccessGrants::Table).to_owned())
            .await?;
        manager
            .create_table(
                Table::create()
                    .table(ImageAccessGrants::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ImageAccessGrants::TokenHash)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ImageAccessGrants::ImageDigest)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ImageAccessGrants::ProjectId)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ImageAccessGrants::ExpiresAt)
                            .big_integer()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum ImageAccessGrants {
    Table,
    TokenHash,
    ImageDigest,
    ProjectId,
    SessionId,
    ExpiresAt,
}
