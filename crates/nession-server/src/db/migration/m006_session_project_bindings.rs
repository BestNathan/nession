//! Migration m006 — `session_project_bindings` (#3082).
//!
//! A Session has zero or one explicit Project membership, owned by the Server.
//! The Agent-reported `sessions` table is a recovery/list cache, so the link
//! lives in its own row and survives Agent reports, reconnects and restarts.
//!
//! `agent_created_at` is the tmux session creation time the Agent reports. It
//! is the incarnation discriminator: a new Session that reuses the same
//! `agent_id:session_name` has a different timestamp and does not inherit the
//! old binding. `0` means the create ACK has not yet been reconciled with the
//! Agent's first report.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let builder = Table::create()
            .table(SessionProjectBindings::Table)
            .if_not_exists()
            .col(
                ColumnDef::new(SessionProjectBindings::SessionId)
                    .string()
                    .not_null()
                    .primary_key(),
            )
            .col(
                ColumnDef::new(SessionProjectBindings::AgentId)
                    .string()
                    .not_null(),
            )
            .col(
                ColumnDef::new(SessionProjectBindings::ProjectId)
                    .string()
                    .not_null(),
            )
            .col(
                ColumnDef::new(SessionProjectBindings::IncarnationId)
                    .string()
                    .not_null()
                    .default(""),
            )
            .col(
                ColumnDef::new(SessionProjectBindings::AgentCreatedAt)
                    .big_integer()
                    .not_null()
                    .default(0),
            )
            .col(
                ColumnDef::new(SessionProjectBindings::Revision)
                    .big_integer()
                    .not_null()
                    .default(1),
            )
            .col(
                ColumnDef::new(SessionProjectBindings::UpdatedAt)
                    .big_integer()
                    .not_null(),
            )
            .to_owned();
        manager.create_table(builder).await?;

        // The tmux instance id is the durable incarnation identity (#3082).
        // It also lives on the Session recovery row so a restart can project a
        // membership before the Agent's first re-report.
        manager
            .alter_table(
                Table::alter()
                    .table(Sessions::Table)
                    .add_column(ColumnDef::new(Sessions::InstanceId).string().null())
                    .to_owned(),
            )
            .await?;

        for (name, column) in [
            (
                "idx_session_project_bindings_project",
                SessionProjectBindings::ProjectId,
            ),
            (
                "idx_session_project_bindings_agent",
                SessionProjectBindings::AgentId,
            ),
        ] {
            let index = Index::create()
                .name(name)
                .table(SessionProjectBindings::Table)
                .col(column)
                .to_owned();
            manager.create_index(index).await.unwrap_or(());
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(SessionProjectBindings::Table)
                    .to_owned(),
            )
            .await
    }
}

#[derive(Iden)]
pub enum SessionProjectBindings {
    Table,
    SessionId,
    AgentId,
    ProjectId,
    IncarnationId,
    AgentCreatedAt,
    Revision,
    UpdatedAt,
}

#[derive(Iden)]
enum Sessions {
    Table,
    InstanceId,
}
