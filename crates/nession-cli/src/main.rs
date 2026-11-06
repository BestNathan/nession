//! nession CLI entrypoint: startup and dispatch only.
//!
//! Command and argument definitions live in [`nession_cli::args`]; routing in
//! [`nession_cli::commands`]; every leaf handler in its own module.

use anyhow::Result;
use clap::Parser;
use nession_cli::args::Cli;
use nession_cli::commands;

fn should_skip_background_check() -> bool {
    if std::env::var("NESSION_NO_UPDATE_CHECK").is_ok() {
        return true;
    }
    let args: Vec<String> = std::env::args().collect();
    for arg in &args {
        if arg == "--help" || arg == "-h" || arg == "help" {
            return true;
        }
    }
    for arg in &args {
        if arg == "--version" || arg == "-V" {
            return true;
        }
    }
    false
}

#[tokio::main]
async fn main() -> Result<()> {
    if !should_skip_background_check() {
        tokio::spawn(async {
            if let Some(msg) = nession_cli::update::check::background_check().await {
                eprintln!("{msg}");
            }
        });
    }

    commands::dispatch(Cli::parse()).await
}
