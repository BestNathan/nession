//! `just codegen` — see the library for what this generates and why.

use std::path::PathBuf;
use std::process::ExitCode;

use nession_protocol_codegen::{run, DEFAULT_OUT};

fn main() -> ExitCode {
    let out = std::env::args()
        .nth(1)
        .map_or_else(|| PathBuf::from(DEFAULT_OUT), PathBuf::from);

    match run(&out) {
        Ok(count) => {
            println!("wrote {count} contract files to {}", out.display());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("codegen failed: {error}");
            ExitCode::FAILURE
        }
    }
}
