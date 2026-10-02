# Gate suites

A suite is an ordered list of stable Gate IDs consumed by \`gates/run --suite\`.

\`\`\`text
gates/suites/<suite-name>.gates
\`\`\`

Each non-comment line is exactly one Gate ID. Suites contain no commands,
metadata, repair text, or changed-file conditions.

Production suites are intentionally not declared until the referenced Gate
adapters exist; otherwise configuration would claim enforcement that is not yet
real.
