# Gate suites

A suite is an ordered list of stable Gate IDs, one per non-comment line.

Use `./gates/run --suite <name>` or `./gates/run --list-suites`.

Suites contain no commands, repair text, changed-file conditions, secrets, or environment setup. They are parallel configuration for future cutover; current hooks/workflows do not consume them yet.
