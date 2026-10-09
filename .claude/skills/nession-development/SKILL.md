---
name: nession-development
description: Use when implementing Nession features/fixes, working from issues, creating worktrees/branches/PRs, running development verification, or deciding the normal code-change workflow.
---

# Nession Development

This Skill owns the **develop -> verify -> publish** workflow. It does not own Gate semantics, release policy, UI design rules, environment installation, or subsystem architecture.

Load related Skills only when needed:

- Gate selection/failures -> `nession-gates`
- CI/staging/release/deploy -> `nession-cicd`
- UI/design/browser proof -> `nession-web-design`
- missing tools/setup -> `nession-env`
- review -> `nession-code-review`

Always read the nearest scoped `AGENTS.md` for files you change.

## 1. Start from latest main

The repository root is a read-only latest-`main` mirror.

Before new work:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git status
```

The root must be clean. Do not edit, commit, create a feature branch, or run feature-development builds there.

## 2. Create an isolated worktree

Every feat/fix/chore/docs/version change uses its own worktree under `.claude/worktrees/`.

Preferred in Claude Code:

```text
EnterWorktree name: "feat/<slug>"
```

Manual:

```bash
git worktree add -b feat/<slug> .claude/worktrees/feat-<slug> origin/main
cd .claude/worktrees/feat-<slug>
```

Use `fix/<slug>` for fixes. Use `chore/` / `docs/` where appropriate.

Only base on `origin/staging` when the change genuinely depends on unreleased staging code.

Verify:

```bash
git branch --show-current   # never main
git status
```

## 3. Discover owners before editing

Before implementation:

1. read the nearest scoped `AGENTS.md`;
2. inspect the issue/requirement and current implementation;
3. discover relevant Gates with `./gates/run --list`;
4. use `./gates/run --describe <id>` for likely invariants;
5. identify the canonical code/doc owner instead of adding parallel policy.

Do not reconstruct protocol/design/Gate rules from old comments or workflow YAML.

## 4. Implement narrowly

Keep one logical responsibility per change. Preserve unrelated work.

For Rust/Web commands, use existing `just` targets and package scripts instead of inventing alternatives.

Useful local entrypoints:

```bash
cargo build
cargo test
just web-lint
just web-test
```

Environment/setup details belong to `nession-env`.

Local build-cache behavior is documented in `references/local-build-cache.md`.

## 5. Verify Gate-first

While iterating, run the narrowest relevant Gate(s).

Examples:

```bash
./gates/run rust-format rust-clippy
./gates/run protocol-integrity protocol-codegen-drift
./gates/run web-eslint web-typecheck web-test-unit
```

Before handoff, run the broader stage-appropriate suite or the repository's current authoritative router. Read `gates/README.md` for rollout state.

Never:

- use `--no-verify`;
- weaken lint/test/coverage/design/protocol rules to land the change;
- convert missing tooling into a green skip;
- delete a Gate/suite entry merely because it fails.

## 6. UI / interaction changes

For visual, layout, interaction, terminal-in-browser, responsive, design-system, or shadcn changes, load `nession-web-design`.

The UI workflow owns browser/visual verification. Do not duplicate its viewport/baseline/design rules here.

## 7. Tests

Tests prove behavior at the cheapest meaningful layer.

- regressions should fail on the original defect;
- shared test state must use isolated ports/files/home;
- do not introduce sleeps/polling when deterministic synchronization exists;
- do not lower coverage thresholds or broad-exclude code to pass;
- use existing test helpers and scoped owners.

Static test/tmux/protocol rules are owned by their checkers/Gates, not this Skill.

## 8. Commit and PR

Before commit:

```bash
git status
git diff --check
```

Use Conventional Commit subjects: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`.

Push the worktree branch and open the PR against the branch required by the current repository flow. Check current CI/CD ownership in `nession-cicd`; do not rely on remembered historical branch policy.

PR evidence should state:

- what changed;
- which relevant Gates/tests ran;
- UI/browser evidence when required;
- known unverified gaps.

## 9. After merge

A merged worktree/branch is finished. Do not keep developing on it.

Refresh root `main`, remove the worktree, prune, and start any follow-up from a fresh branch.

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git worktree remove .claude/worktrees/<name>
git worktree prune
```

## Batch issue work

When asked to handle multiple issues:

1. pull by explicit label/scope rather than keyword guesses;
2. check for existing PR/branch/claim;
3. order by file/owner overlap;
4. default to one issue -> one branch/PR unless one implementation genuinely closes multiple issues;
5. report the batch plan before mutating shared areas.

## Stop conditions

Stop and resolve ownership before continuing when:

- the task requires editing root `main`;
- two instruction/rule owners conflict;
- a proposed bypass is the only way to make a Gate green;
- a change depends on unreleased behavior but its base is unclear;
- a UI change has no realistic validation path.

## References

- `references/local-build-cache.md` — local Rust cache/worktree mechanics
- `references/shadcn-components.md` — current shadcn inventory/reference
- root `AGENTS.md` — repository-wide laws
- nearest scoped `AGENTS.md` — subsystem invariants
