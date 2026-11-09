//! Standalone in-sandbox bridge for tests and non-Agent consumers (#2681).
//!
//! The Agent binary exposes the same `nession_sandbox::bridge::run` as a
//! hidden subcommand, so production needs no second artifact. This binary
//! exists so the Linux runtime test can execute the real bridge without a
//! built Agent.

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(nession_sandbox::bridge::run(&arguments));
}
