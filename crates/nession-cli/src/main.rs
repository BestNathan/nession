//! nession CLI entrypoint: version selection, startup and dispatch only.
//!
//! Command and argument definitions live in [`nession_cli::args`]; routing in
//! [`nession_cli::commands`]; every leaf handler in its own module. Release
//! selection happens before Clap so `nession +<version> …` / `NESSION_VERSION`
//! can hand the command to an archived CLI without changing Current (#3173).

use anyhow::Result;
use clap::Parser;
use nession_cli::args::Cli;
use nession_cli::commands;
use nession_cli::versions;
use std::ffi::OsString;

fn should_skip_background_check(args: &[OsString]) -> bool {
    if std::env::var("NESSION_NO_UPDATE_CHECK").is_ok() {
        return true;
    }
    for arg in args {
        if let Some("--help" | "-h" | "help" | "--version" | "-V") = arg.to_str() {
            return true;
        }
    }
    false
}

#[tokio::main]
async fn main() -> Result<()> {
    // A previous install may have been killed between moving state and
    // swapping binaries. Recover (or fail closed) before any command reads
    // Current; `version list` included (#3232 F4). The diagnostic goes to
    // stderr so it cannot corrupt a command's parseable stdout.
    if let Some(message) = nession_cli::update::transaction::recover_at_cli_start()?.describe() {
        eprintln!("{message}");
    }

    // This may `exec` an archived release and never return. When it returns,
    // the Current CLI owns the command.
    let prepared = versions::prepare(std::env::args_os())?;

    if prepared
        .args
        .iter()
        .any(|argument| argument == "--lifecycle-contract")
    {
        println!("{}", nession_cli::lifecycle::contract_line());
        return Ok(());
    }

    if !should_skip_background_check(&prepared.args) {
        tokio::spawn(async {
            if let Some(msg) = nession_cli::update::check::background_check().await {
                eprintln!("{msg}");
            }
        });
    }

    commands::dispatch(Cli::parse_from(prepared.args)).await
}
