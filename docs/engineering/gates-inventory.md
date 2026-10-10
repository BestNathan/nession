# Repository Gate inventory and migration audit — #1242

This is the **classification and migration audit**, not a second registry of Gate
implementations. The complete, always-current Gate ID inventory is the
executable catalog in `gates/checks/<gate-id>.sh`:

```bash
./gates/run --list
./gates/run --list-suites
./gates/run --describe protocol-integrity
./gates/run --validate
```

`--validate` checks filename/ID identity, executable mode, shell syntax,
metadata and all Suite references. Do **not** copy the complete list of Gate IDs
or Suite membership here: that would create another owner and drift. The
examples/mappings below are classifications, not independent enforcement.

## Classification rules

| Class | Meaning and canonical location | Blocking? |
|---|---|---|
| **Gate** | One named executable invariant, exactly `gates/checks/<id>.sh`; use `--describe` for exact command, owner and repair | Yes, when selected |
| **Gate implementation** | Domain rule engine invoked by its Gate, e.g. `scripts/protocol-gate.mjs`, `design/scripts/design-gate.mjs`, `scripts/check-coverage.sh` | Through its Gate |
| **Router** | Selects Gate IDs/cost profile and invokes `gates/run`: Hooks, Justfile, GitHub workflow | Selected Gates only |
| **Diagnostic** | Provides evidence but is probabilistic, observational or nonblocking | No |
| **Utility / operation** | Installs dependencies, builds/bundles, publishes, deploys, updates snapshots or creates artifacts | Not a repository invariant |

A command can be essential to a successful workflow without being a Gate.
For example, a failing Docker image build blocks deployment, but packaging
itself is an operation rather than a reproducible source-quality invariant.

## Gate implementation ownership / original check mapping

| Invariant family | Stable Gate IDs / profiles | Underlying rule owner |
|---|---|---|
| Worktree policy | `dev-workspace-commit`, `dev-workspace-push` | `scripts/check-dev-workspace.sh` |
| Rust format, lint and tests | `rust-format`, `rust-clippy`, `rust-test-unit`, `rust-test-integration`, `rust-coverage` | rustfmt, Clippy, `scripts/filtered-test.sh`, `scripts/check-coverage.sh` |
| Rust build cache/worktree safety | `rustc-wrapper`, `worktree-target-seed`, `build-cache-verifier` | Their individual `scripts/*selftest.sh` owners |
| Test/tmux isolation | `test-isolation`, `tmux-socket-isolation`; matching `-selftest` IDs | `scripts/check-test-isolation.sh`, `scripts/check-tmux-socket.sh` |
| Protocol correctness and generated bindings | `protocol-integrity`, `protocol-json-contract`, `protocol-codegen-drift`, `protocol-integrity-selftest` | `scripts/protocol-gate.mjs`, `scripts/check-codegen-drift.sh` |
| Design invariants | `design-system-fast`, `design-system-full`, `design-system-browser` | `design/scripts/design-gate.mjs` |
| Web type/lint/test/coverage | `web-eslint`, `web-typecheck`, `web-test-unit`, `web-test-integration`, `web-coverage` | ESLint/TypeScript/Vitest and existing Web test helpers |
| Acceptance and Requirement governance | `acceptance-runtime-contract`, `acceptance-cases-contract`, `requirement-acceptance-pre-merge`, `requirement-acceptance-pr`, `requirement-acceptance-close`, their named deterministic self-tests | `scripts/requirement-acceptance.mjs`, canonical E2E/Acceptance harness, trusted ingestion |
| Runtime/browser and evidence integrity | `e2e-playwright`, `e2e-cli-discovery` and E2E/Run Record/Case/Scenario/collector `-selftest` IDs | `e2e/run`, `e2e/runner`, `scripts/*ingest*.mjs` |
| Repository instructions, audit, metrics, tasks, telemetry | `instruction-contract`, `issue-contract-selftest`, `repo-health-selftest`, `repo-metrics-selftest`, `agent-workflow-telemetry`, task/audit self-test IDs | Individual `scripts/*.mjs` rule engines; see `--describe` |
| Release version equality | `release-version-consistency` | Rust workspace / Web package version files |
| Gate system itself | `gate-runtime-contract`; Hook routing regression test tracked in #1242 | `gates/run`, `gates/lib/common.sh`, runner and contract self-tests |

## Execution-surface audit

| Surface | Classification | Canonical mapping / evidence boundary |
|---|---|---|
| `.githooks/pre-commit` | Router + screenshot-relocation utility | Staged diff selects named Gate IDs; `gates/run` aggregates. Screenshot relocation is not a quality check |
| `.githooks/pre-push` | Router | Pushed SHA diff and fallback choose Rust/Web/design/protocol/self-test Gate IDs; missing diff base must broaden selection |
| `justfile` | Router plus developer utilities | `just gate <id>`, `just gates <suite>`, `just check` → `quality-rust`, Web commands → exact Web Gate IDs |
| `.github/workflows/quality.yml` | Router + environment setup | Rust `quality-rust`, repository `quality-tooling`, Web/design Gate IDs. Node/npm/Rust setup is a utility |
| `.github/workflows/e2e.yml` | Router + runtime/build + snapshot operation | Normal `e2e-playwright` (canonical `e2e/run test --all`), `design-system-browser`; snapshot regeneration is not a passing Gate |
| `.github/workflows/staging.yml` | Router + build/deploy operations | Rust/Web Gate IDs run before build; image build, registry publication and GitOps updates are operations |
| `.github/workflows/release.yml` | Router + version decision + deploy operations | Rust/Web Gate IDs; equality invariant belongs to `release-version-consistency`, while version advance, tag retry and publication remain release-policy operations |
| `.github/workflows/requirement-acceptance.yml` | Router / trusted authorization boundary | Stage-specific `requirement-acceptance-pre-merge`, `-pr`, `-close` Gate IDs; trust/permissions remain workflow-owned |
| Other Acceptance/Run Record ingestion workflows | Router + trusted record operation | Shared validator/ingestion self-tests are Gates; authenticated immutable storage and dispatch are operations |

The logical `staging.gates` and `release.gates` profiles describe reusable
Gate sets; they do **not** replace job-specific credentials, provisioning,
version decisions or deployment. Suite files remain ID-only.

## Explicitly non-Gate inventory

| Class | Examples | Why |
|---|---|---|
| Diagnostic | `scripts/check-test-concurrency.sh`, build-cache status/measurement, design inventory reports | Timing-sensitive or observational evidence, not an invariant |
| Utility | `npm ci`, Cargo/Node/Playwright installs, generated artifact creation, Docker packaging, image upload, GitOps updates | Prerequisite, build action or mutating operation |
| Utility | Snapshot baseline regeneration with `--update-snapshots=all` | Changes the expected answer; cannot count as a successful regression check |
| Trusted workflow operation | GitHub event extraction, source-SHA proof acquisition, run-record indexing, Issue update, credential handling | Authorized orchestration, not a shadow copy of the underlying rule |

## Parity and cutover verification

1. For every migrated legacy command, compare its **exact underlying executable**
   with the Gate's `--describe` and source. Preserve coverage, target options and
   required runtime prerequisites.
2. Run deterministic known-good and known-bad fixtures for custom detectors.
   A validator that returns green after its negative fixture is a broken Gate.
3. When editing a Gate or its validator, prove the relevant router selects the
   contract/self-test even for a Gate-only change. If diff discovery cannot be
   trusted, fail closed or broaden checks rather than skip.
4. Confirm Quality, E2E and Acceptance at the **exact PR head** before merge;
   separately confirm any required merged-SHA or deployment checks.
5. A historical helper can remain the implementation called by a Gate; it must
   not remain a second copy of the rule in Hooks, Justfile or workflow YAML.

The #1242 Success Criteria / Acceptance Report, not this inventory, determine
when all remaining migration and no-regression proof is complete.
