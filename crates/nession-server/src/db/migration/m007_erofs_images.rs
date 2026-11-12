//! Migration m007 — global EROFS image manager tables (#3022).
//!
//! Images are Server-owned immutable metadata; aliases are mutable tags that
//! resolve to an immutable digest; leases and access grants are bounded,
//! expiring authorization state. Project references stay in `projects` (the
//! Project owns its declaration), so GC can query them without a second copy.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Images::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Images::ImageId)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Images::Digest).string().null())
                    .col(
                        ColumnDef::new(Images::SizeBytes)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(ColumnDef::new(Images::SourceJson).text().not_null())
                    .col(ColumnDef::new(Images::SourceSha).string().null())
                    .col(ColumnDef::new(Images::PackagingJson).text().not_null())
                    .col(ColumnDef::new(Images::Status).string().not_null())
                    .col(ColumnDef::new(Images::Error).text().null())
                    .col(ColumnDef::new(Images::CreatedAt).big_integer().not_null())
                    .col(ColumnDef::new(Images::UpdatedAt).big_integer().not_null())
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_images_digest")
                    .table(Images::Table)
                    .col(Images::Digest)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(ImageAliases::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ImageAliases::Alias)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ImageAliases::ImageDigest)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ImageAliases::CreatedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ImageAliases::UpdatedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_image_aliases_digest")
                    .table(ImageAliases::Table)
                    .col(ImageAliases::ImageDigest)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(ImageLeases::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ImageLeases::LeaseId)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(ImageLeases::ImageDigest).string().not_null())
                    .col(ColumnDef::new(ImageLeases::ProjectId).string().not_null())
                    .col(
                        ColumnDef::new(ImageLeases::ExpiresAt)
                            .big_integer()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_image_leases_digest")
                    .table(ImageLeases::Table)
                    .col(ImageLeases::ImageDigest)
                    .to_owned(),
            )
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
            .drop_table(Table::drop().table(ImageLeases::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(ImageAliases::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(Images::Table).to_owned())
            .await?;
        Ok(())
    }
}

#[derive(Iden)]
pub enum Images {
    Table,
    ImageId,
    Digest,
    SizeBytes,
    SourceJson,
    SourceSha,
    PackagingJson,
    Status,
    Error,
    CreatedAt,
    UpdatedAt,
}

#[derive(Iden)]
pub enum ImageAliases {
    Table,
    Alias,
    ImageDigest,
    CreatedAt,
    UpdatedAt,
}

#[derive(Iden)]
pub enum ImageLeases {
    Table,
    LeaseId,
    ImageDigest,
    ProjectId,
    ExpiresAt,
}

#[derive(Iden)]
pub enum ImageAccessGrants {
    Table,
    TokenHash,
    ImageDigest,
    ProjectId,
    ExpiresAt,
}
