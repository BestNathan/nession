# Gate suites

A suite is an ordered list of stable Gate IDs, one per non-comment line.

Use `./gates/run --suite <name>` or `./gates/run --list-suites`.

Suites contain no commands, repair text, changed-file conditions, secrets, or environment setup. They model logical execution surfaces rather than declaring CI coverage on their own.

**Live consumers:** `just check` already runs `./gates/run --suite quality-rust`, and Git hooks route changed-file Gate ID selections through `./gates/run`. Other suites are not automatically enforced merely because their `.gates` files exist. Consult `justfile`, `.githooks/` and `.github/workflows/` for current routing. Remaining workflow and tooling migration is tracked in #1242.
