# Gate suites

A suite is an ordered list of stable Gate IDs, one per non-comment line.

Use `./gates/run --suite <name>` or `./gates/run --list-suites`.

Suites contain no commands, repair text, changed-file conditions, secrets, or environment setup. They are plans for future suite-based cutover. Hooks/workflows still own most routing and may call *individual* `gates/run` IDs; suite files alone do not prove that CI consumes them.
