# Gate inventory — #1242 baseline

Status: **runtime-contract phase; no existing consumer has been cut over.**

Future concrete Gate path: \`gates/checks/<gate-id>.sh\`.
Multi-Gate execution: \`gates/run\`.
Suite composition: \`gates/suites/<suite>.gates\`.

| Concern | Current rule/implementation owner | Current consumers | Classification now | Candidate Gate ID | Migration note |
|---|---|---|---|---|---|
| development workspace policy | \`scripts/check-dev-workspace.sh\` | pre-commit, pre-push, \`just check-workspace\` | Gate implementation + routers | \`dev-workspace\` | mode-specific inputs need an explicit Gate contract |
| Rust formatting | \`cargo fmt --all -- --check\` | \`just fmt\`, \`just quick\`, CI | Gate command | \`rust-format\` | straightforward adapter |
| Rust clippy | \`cargo clippy --workspace --all-targets -- -D warnings\` | \`just lint\`, \`just quick\`, CI | Gate command | \`rust-clippy\` | straightforward adapter |
| Rust tests | filtered test scripts / cargo test | hooks, \`just test*\`, CI via coverage | Gate command(s) | \`rust-tests\` | decide unit/full semantics before migration |
| Rust coverage | \`scripts/check-coverage.sh\` | pre-push, \`just coverage\`, CI | Gate implementation | \`rust-coverage\` | preserve per-crate thresholds as domain truth |
| rustc-wrapper behavior | \`scripts/rustc-wrapper-selftest.sh\` | \`just check\` / CI | Repository tooling invariant | \`rustc-wrapper\` | blocking today; must not disappear |
| worktree target seeding | \`scripts/seed-worktree-target-selftest.sh\` | \`just check\` / CI | Repository tooling invariant | \`worktree-target-seed\` | blocking today |
| build-cache verifier behavior | \`scripts/build-cache-verify-selftest.sh\` | \`just check\` / CI | Repository tooling invariant | \`build-cache-verifier\` | distinct from non-blocking cache diagnostic |
| test isolation | \`scripts/check-test-isolation.sh\` + self-test | pre-commit / just | Gate implementation | \`test-isolation\` | preserve deterministic self-test |
| concurrent test stress | \`scripts/check-test-concurrency.sh\` | manual just recipe | Diagnostic | none | remain non-blocking |
| tmux socket isolation | \`scripts/check-tmux-socket.sh\` + self-test | pre-commit, \`just check\` / CI | Gate implementation | \`tmux-socket-isolation\` | preserve self-test and repair guidance |
| protocol integrity | \`scripts/protocol-gate.mjs\` + self-test | hooks, \`just check\` / CI | Gate implementation | \`protocol-integrity\` | good first parallel adapter |
| protocol codegen drift | \`scripts/check-codegen-drift.sh\` | pre-push, \`just check\` / CI | Gate implementation | \`protocol-codegen-drift\` | check must not mutate committed source |
| design system | \`design/scripts/design-gate.mjs\` | pre-commit fast, pre-push/CI full | Gate implementation with profiles | \`design-system\` | keep profiles only if one invariant |
| Web ESLint | ESLint config / \`just web-lint\` | pre-commit, CI | Gate command | \`web-eslint\` | likely split from TypeScript |
| Web TypeScript | TypeScript config / \`just web-lint\` | pre-commit, CI | Gate command | \`web-typecheck\` | likely separate Gate |
| Web tests | filtered Vitest runner | hooks, CI | Gate command(s) | \`web-tests\` | decide unit/full semantics |
| Web coverage | Vitest coverage thresholds | pre-push | Gate command | \`web-coverage\` | do not imply CI enforcement early |
| requirement acceptance | \`scripts/requirement-acceptance.mjs\` | acceptance workflow | Gate implementation | \`requirement-acceptance\` | preserve trusted-default-branch boundary |
| acceptance report execution | acceptance executor/agent | workflow | Automation | none | separate from validator |
| E2E workflow | \`.github/workflows/e2e.yml\` | GitHub Actions | Router + runtime assertions | TBD | classify assertions |
| staging workflow | \`.github/workflows/staging.yml\` | GitHub Actions | Router + deployment/verification | TBD | deployment is not automatically a Gate |
| release workflow | \`.github/workflows/release.yml\` | GitHub Actions | Router + release/assertions | TBD | only reusable invariants become Gates |
| deploy workflow | \`.github/workflows/deploy.yml\` | GitHub Actions | Operation | none | deployment action is not itself an invariant |
| repository metrics | repo-metrics workflow | scheduled/manual | Diagnostic | none | outside blocking layer |
| issue audit agent | issue-audit workflow | issue/manual events | Automation/diagnostic | none | not a repository invariant |

## Runtime boundary

\`\`\`text
gates/
├── run
├── checks/<gate-id>.sh
├── suites/<suite>.gates
└── lib/
\`\`\`

The runner executes the complete selected set, emits one compact result line per
Gate, and expands full output only for FAIL/ERROR. Suite files declare only IDs;
changed-file selection remains a router concern.

## Current routers unchanged in this phase

- \`.githooks/pre-commit\`
- \`.githooks/pre-push\`
- \`justfile\`
- \`.github/workflows/quality.yml\`
- \`.github/workflows/requirement-acceptance.yml\`
- \`.github/workflows/e2e.yml\`
- \`.github/workflows/staging.yml\`
- \`.github/workflows/release.yml\`

## Migration proof per Gate

Before switching a consumer:

1. identify old command and candidate \`gates/checks/<id>.sh\`;
2. prove same known-pass and known-violation behavior;
3. prove tooling failure is ERROR/non-zero;
4. preserve deterministic self-tests;
5. prove caller-CWD independence and no normal source mutation;
6. preserve routing/cost behavior unless explicitly approved;
7. only then add the ID to a production suite or explicit runner call;
8. remove old duplicate orchestration/repair prose only during cutover.
