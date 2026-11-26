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

#[tokio::main]
async fn main() -> Result<()> {
    let raw_args: Vec<OsString> = std::env::args_os().collect();

    // `logs` is read-only: no install-recovery mutation, only a diagnostic
    // when a transaction is pending (#4600 SC-04). Every other command
    // recovers (or fails closed) before reading Current (#3232 F4, #4592).
    if versions::is_logs_invocation(&raw_args) {
        nession_cli::update::transaction::report_pending_journal_for_read_only_command();
    } else {
        nession_cli::update::transaction::recover_before_command(&raw_args)?;
    }

    // May `exec` an archived release and never return (#3173).
    let prepared = versions::prepare(raw_args)?;

    // Read-only capability handshakes (#3628, #4592 §6). The shell installer
    // delegates an upgrade only to a CLI advertising the upgrade token.
    if let Some(line) = nession_cli::update::capability_probe_line(&prepared.args) {
        println!("{line}");
        return Ok(());
    }
    if let Some(code) = nession_cli::update::config_check::probe_exit_code(&prepared.args) {
        std::process::exit(code);
    }

    if !versions::should_skip_background_check(&prepared.args) {
        tokio::spawn(async {
            if let Some(msg) = nession_cli::update::check::background_check().await {
                eprintln!("{msg}");
            }
        });
    }

    commands::dispatch(Cli::parse_from(prepared.args)).await
}
