# Nession Repository Instructions

Nession is an intelligent workspace for continuous work across devices, environments, compute nodes, terminals, and coding agents.

This file is the **canonical always-on repository instruction surface**. Keep it small. Detailed workflows, subsystem rules, architecture rationale, inventories, and runbooks belong to scoped `AGENTS.md` files, Skills, or `docs/`.

## Product direction

For any user-facing or product-facing change, read:

1. [VISION.md](VISION.md) — what Nession exists to become.
2. [PRINCIPLE.md](PRINCIPLE.md) — durable product decision constraints.
3. Relevant material under [docs/design/](docs/design/) for the affected surface.

Lower-level code, fixtures, screenshots, and historical docs do not override Vision or Principles.

## Instruction model

Use the narrowest owner that applies:

```text
explicit task / user scope
  ↓
nearest scoped AGENTS.md
  ↓
root AGENTS.md
  ↓
selected task Skill
  ↓
canonical docs / code / Gate facts
```

- Read the nearest `AGENTS.md` for every subtree you modify.
- A scoped instruction owns path-local invariants; a Skill coordinates a task workflow.
- A Skill must not override a scoped owner's invariant.
- Executable behavior lives with code/Gates/validators. Prose points to it rather than copying volatile rule lists.
- If instruction surfaces disagree, identify the canonical owner and repair the conflict.

Claude compatibility uses sibling `CLAUDE.md -> AGENTS.md` symlinks. Edit `AGENTS.md`, never the compatibility link.

## Repository-wide engineering laws

### 1. One owner per responsibility

A state transition, policy, protocol rule, validation rule, or product decision has one canonical owner. Callers consume that owner; adapters translate it. Do not create competing implementations or prose copies.

### 2. Root checkout is a read-only latest-main mirror

The project root stays on clean, current `main`. Use it to fetch, inspect, and create/remove worktrees.

All edits, commits, version bumps, workflow changes, and release preparation happen in an isolated worktree.

For the exact workflow load [nession-development](.claude/skills/nession-development/SKILL.md).

### 3. Gate-first verification

Before inventing a new hook/workflow check, ask which repository invariant must be proven and whether a Gate already owns it.

```bash
./gates/run --list
./gates/run --describe <gate-id>
./gates/run --validate
```

Never bypass a failing Gate. For Gate design, repair, suites, or routing load [nession-gates](.claude/skills/nession-gates/SKILL.md).

### 4. Preserve unrelated work and authority boundaries

Inspect repository state before mutation. Do not overwrite unrelated work, reuse a checkout owned by another task, weaken a quality rule to land a change, or perform deployment/release/destructive actions outside the requested scope.

### 5. Fix owners, not symptoms

Reproduce the real failing boundary when practical. Fix invalid state/rules at their producer or owner. Compatibility paths require an actual compatibility contract, not convenience.

## Task Skills

Skills are task-local workflows. Load only what the task needs.

| Task | Skill |
|---|---|
| feature/fix development, worktrees, tests, PR flow | [nession-development](.claude/skills/nession-development/SKILL.md) |
| Gate design/use/failure repair | [nession-gates](.claude/skills/nession-gates/SKILL.md) |
| code/architecture/runtime review | [nession-code-review](.claude/skills/nession-code-review/SKILL.md) |
| CI, staging, release, deployment | [nession-cicd](.claude/skills/nession-cicd/SKILL.md) |
| Agent workflow telemetry, persistence, aggregation | [nession-agent-workflow-metrics](.claude/skills/nession-agent-workflow-metrics/SKILL.md) |
| requirement/bug issue authoring | [nession-writing-requirements](.claude/skills/nession-writing-requirements/SKILL.md) |
| stage-specific acceptance | [nession-acceptance](.claude/skills/nession-acceptance/SKILL.md) |
| one-time CI script/ephemeral Task execution | [nession-task](.claude/skills/nession-task/SKILL.md) |
| Web UI/design-system work | [nession-web-design](.claude/skills/nession-web-design/SKILL.md) |
| development environment/setup | [nession-env](.claude/skills/nession-env/SKILL.md) |

Cross-agent discovery exposes the same physical Skill tree at `.agents/skills`; `.claude/skills` remains the content owner for compatibility with current Nession automation.

## Scoped owners

Read these when modifying their trees:

- [web/AGENTS.md](web/AGENTS.md) — Web layering, state/import/transport boundaries.
- [crates/nession-protocol/AGENTS.md](crates/nession-protocol/AGENTS.md) — Protocol Kernel and contract evolution.
- [crates/nession-agent/AGENTS.md](crates/nession-agent/AGENTS.md) — Agent runtime and tmux safety.
- [design/AGENTS.md](design/AGENTS.md) — design sources/generated artifacts.
- [scripts/AGENTS.md](scripts/AGENTS.md) — repository automation/checker ownership.
- [.github/AGENTS.md](.github/AGENTS.md) — workflow/router and trust-boundary rules.
- [docs/AGENTS.md](docs/AGENTS.md) — documentation placement and authority.

Repository architecture is under [docs/architecture/](docs/architecture/). Product/UI doctrine is under [docs/design/](docs/design/). Instruction ownership is documented in [docs/engineering/instruction-architecture.md](docs/engineering/instruction-architecture.md).

## Working discipline

- Read the relevant owner before editing.
- Prefer narrow proof while iterating; run the broader relevant Gate/suite before handoff.
- Do not hide failures with skips, suppressions, weakened thresholds, or duplicated weaker checks.
- Generated files are changed through their generator unless their owner explicitly says otherwise.
- Report what was verified and what remains unverified.
- When adding guidance, place it at the narrowest durable owner instead of appending it here.

If a rule is not relevant to nearly every repository task, it probably does not belong in this file.
