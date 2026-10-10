# Gate suites

A suite is an ordered list of stable Gate IDs, one per non-comment line.

Use `./gates/run --suite <name>` or `./gates/run --list-suites`.

Suites contain no commands, repair text, changed-file conditions, secrets, or environment setup. `quality-rust` is consumed by `just check` and Rust CI quality; other suites can model future cutover surfaces. Hooks route changed-file Gate ID selections through `./gates/run`, and workflows may call individual Gates. The existence of a suite file alone does not prove any CI job consumes it. Check `justfile`, `.githooks/`, and `.github/workflows/` for live routing.
