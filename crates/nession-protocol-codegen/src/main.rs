//! `just codegen` and `just protocol-schema` — see the library for what each
//! generates and why.
//!
//! Two projections of the same catalog, so they share an entry point rather
//! than a binary each: `catalog` is the one list, and a second executable would
//! be a second place to keep it.

use std::path::PathBuf;
use std::process::ExitCode;

use nession_protocol_codegen::{run, schema, DEFAULT_OUT};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // `--schema [OPERATION]` prints the JSON Schema document; no argument means
    // the whole catalog, and one means that protocol alone. Written to stdout
    // so it pipes, and so `just protocol-schema > file.json` needs nothing
    // from this binary.
    if args.first().is_some_and(|a| a == "--schema") {
        let only = args.get(1).map(String::as_str);
        let document = schema::document(only);
        match serde_json::to_string_pretty(&document) {
            Ok(text) => {
                println!("{text}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("could not serialise the schema: {error}");
                ExitCode::FAILURE
            }
        }
    } else {
        let out = args
            .first()
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
}
