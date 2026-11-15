//! Migration m011 — preserve Session Project membership generations (#3661).
//!
//! Removing a membership no longer deletes its row: the row becomes an
//! unassociated tombstone that keeps the Session's last revision. Reusing the
//! old row identity is what allowed an ABA sequence — associate at revision 1,
//! remove (revision 0), re-associate at revision 1 — where a client holding the
//! stale revision 1 silently overwrote the newer association.
//!
//! Existing rows are all active memberships, so the default backfills them as
//! associated. Tombstones keep `project_id` empty and are hidden from every
//! membership read; they exist only to advance the revision monotonically
//! across remove/reassociate and Project deletion.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(SessionProjectBindings::Table)
                    .add_column(
                        ColumnDef::new(SessionProjectBindings::Associated)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // A tombstone is not a membership; without the flag it would read as
        // an active binding with an empty project id.
        manager
            .get_connection()
            .execute_unprepared("DELETE FROM session_project_bindings WHERE associated = 0")
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(SessionProjectBindings::Table)
                    .drop_column(SessionProjectBindings::Associated)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum SessionProjectBindings {
    Table,
    Associated,
}
