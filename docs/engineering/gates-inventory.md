# Gate inventory — #1242 baseline

Status: **Phase 1 audit baseline; no cutover has happened.**

This document records the current quality surfaces before migration. It is
deliberately separate from \`gates/*.sh\`: the entrypoint is the future
executable contract; this inventory is migration evidence and can change as the
audit discovers more surfaces.

| Concern | Current rule/implementation owner | Current consumers | Classification now | Candidate gate | Phase 1 decision |
|---|---|---|---|---|---|
| development workspace policy | \`scripts/check-dev-workspace.sh\` | pre-commit, pre-push, \`just check-workspace\` | Gate implementation + routers | \`dev-workspace\` | migrate later; mode-specific inputs need an explicit contract |
| Rust formatting | \`cargo fmt --all -- --check\` | \`just fmt\`, \`just quick\`, CI | Gate command | \`rust-format\` | straightforward adapter |
| Rust clippy | \`cargo clippy --workspace --all-targets -- -D warnings\` | \`just lint\`, \`just quick\`, CI | Gate command | \`rust-clippy\` | straightforward adapter |
| Rust tests | filtered test scripts / cargo test | pre-commit, pre-push, \`just test*\`, CI via coverage | Gate command(s) | \`rust-tests\` | decide whether unit/full are cost profiles or separate invariants before migration |
| Rust coverage | \`scripts/check-coverage.sh\` | pre-push, \`just coverage\`, CI | Gate implementation | \`rust-coverage\` | preserve per-crate thresholds as domain truth |
| rustc-wrapper behavior | \`scripts/rustc-wrapper-selftest.sh\` | \`just check\` / CI | Repository tooling invariant | \`rustc-wrapper\` | blocking today, therefore must not disappear in migration |
| worktree target seeding | \`scripts/seed-worktree-target-selftest.sh\` | \`just check\` / CI | Repository tooling invariant | \`worktree-target-seed\` | blocking today |
| build-cache verifier behavior | \`scripts/build-cache-verify-selftest.sh\` | \`just check\` / CI | Repository tooling invariant | \`build-cache-verifier\` | distinguish from \`build-cache-verify\`, which is diagnostic |
| test isolation | \`scripts/check-test-isolation.sh\` + self-test | pre-commit / just | Gate implementation | \`test-isolation\` | preserve deterministic self-test |
| concurrent test stress run | \`scripts/check-test-concurrency.sh\` | manual just recipe | Diagnostic | none | remain non-blocking |
| tmux socket isolation | \`scripts/check-tmux-socket.sh\` + self-test | pre-commit, \`just check\` / CI | Gate implementation | \`tmux-socket-isolation\` | preserve self-test and repair guidance |
| protocol integrity | \`scripts/protocol-gate.mjs\` + self-test | pre-commit, pre-push, \`just check\` / CI | Gate implementation | \`protocol-integrity\` | good first real adapter after contract lands |
| protocol codegen drift | \`scripts/check-codegen-drift.sh\` | pre-push, \`just check\` / CI | Gate implementation | \`protocol-codegen-drift\` | do not regenerate committed source as part of check |
| design system | \`design/scripts/design-gate.mjs\` | pre-commit fast, pre-push full, CI full | Gate implementation with profiles | \`design-system\` | retain fast/full profiles only if they remain the same invariant |
| Web ESLint | ESLint config / \`just web-lint\` | pre-commit, CI | Gate command | \`web-eslint\` candidate | current \`web-lint\` also runs tsc; split decision needed because repairs differ |
| Web TypeScript | TypeScript config / \`just web-lint\` | pre-commit, CI | Gate command | \`web-typecheck\` candidate | split from ESLint unless migration evidence supports one invariant |
| Web tests | filtered Vitest runner | pre-commit, pre-push, CI | Gate command(s) | \`web-tests\` | decide unit/full cost profile semantics |
| Web coverage | Vitest coverage thresholds | pre-push | Gate command | \`web-coverage\` | CI currently does not enforce it; migration must not accidentally claim wider enforcement |
| requirement acceptance | \`scripts/requirement-acceptance.mjs\` | \`requirement-acceptance.yml\` PR/issue guards | Gate implementation | \`requirement-acceptance\` | GitHub-state gate; trusted-default-branch security boundary must be preserved |
| acceptance execution/report update | acceptance executor/agent + \`acceptance.yml\` | workflow dispatch / issue updates | Workflow/automation, not itself the acceptance invariant | none initially | audit separately from the acceptance validator |
| E2E workflow | \`.github/workflows/e2e.yml\` | GitHub Actions | Router + runtime assertions | TBD | inspect each blocking assertion before classifying |
| staging workflow | \`.github/workflows/staging.yml\` | GitHub Actions | Router + deploy/verification operations | TBD | deployment operations are not automatically gates |
| release workflow | \`.github/workflows/release.yml\` | GitHub Actions | Router + release operations + assertions | TBD | only reusable blocking invariants become gates |
| deploy workflow | \`.github/workflows/deploy.yml\` | GitHub Actions | Operation | none by default | deployment is an action, not a repository invariant |
| repository metrics | repo-metrics scripts/workflow | scheduled/manual workflow | Diagnostic/telemetry | none | keep out of blocking gate layer |
| issue audit agent | issue-audit scripts/workflow | issue events/manual workflow | Automation/diagnostic | none | not a repository quality invariant |

## Current routers that must remain unchanged during Phase 1

- \`.githooks/pre-commit\`
- \`.githooks/pre-push\`
- \`justfile\`
- \`.github/workflows/quality.yml\`
- \`.github/workflows/requirement-acceptance.yml\`
- \`.github/workflows/e2e.yml\`
- \`.github/workflows/staging.yml\`
- \`.github/workflows/release.yml\`

Phase 1 must not replace invocations in these files.

## Migration proof required per gate

Before switching any consumer, the migration PR must show all of the following:

1. the existing command and the candidate \`gates/<id>.sh\` invocation;
2. same known-pass behavior;
3. same known-violation behavior;
4. tooling failure becomes ERROR/non-zero, never skip/pass;
5. existing deterministic self-tests still pass;
6. caller-CWD independence;
7. no source mutation during a normal check;
8. current routing/cost behavior is preserved or the behavior change is
   explicitly approved;
9. old duplicate rule/repair prose is removed only in the cutover commit.

## Open classification questions for Phase 2

- Whether Rust/Web unit-vs-full test runs are profiles of one invariant or
  independently meaningful gates.
- Whether current \`web-lint\` should become one gate or split into ESLint and
  TypeScript gates; their repair paths are different, so split is the default
  candidate.
- Which assertions embedded in E2E/staging/release workflows are reusable
  repository invariants versus environment/deployment operations.
- How \`requirement-acceptance\` represents GitHub event/context inputs while
  keeping \`pull_request_target\` on the trusted default branch.
