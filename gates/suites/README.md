# Gate suites

A suite is an ordered list of stable Gate IDs, one per non-comment line.
Use `./gates/run --suite <name>` or `./gates/run --list-suites`.

Suites contain no commands, environment setup, repair prose, changed-file conditions, secrets, or inline shell. `quality-rust` is consumed by `just check` and Rust CI quality.

**Git hooks are live suite consumers.** `.githooks/pre-commit` and `.githooks/pre-push` delegate to `gates/route`, which reads the matching stage suite and decides which listed IDs apply to the staged/pushed diff. The suite owns stage membership; `gates/route` owns applicability; `gates/checks/<id>.sh` owns the invariant; `gates/run` owns execution and failure semantics. An unknown suite Gate fails closed. `./gates/run --suite pre-commit` deliberately runs the **entire** stage suite, not changed-file selection.

Other workflows may call individual Gates. The existence of another suite file alone does not prove CI consumes it; inspect current workflows for live routing.
