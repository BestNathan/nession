//! Database migrations for the nession server.
//!
//! Uses the sea-orm-migration `MigratorTrait` / `MigrationTrait` contract.
//! Each migration is a single file; the migrator orders them by the order
//! returned from `migrations()`.

use sea_orm_migration::prelude::*;

mod m001_initial;
mod m002_env_files;
mod m003_quick_commands;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m001_initial::Migration),
            Box::new(m002_env_files::Migration),
            Box::new(m003_quick_commands::Migration),
        ]
    }
}
