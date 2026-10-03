# Repository Instruction Architecture

Nession applies progressive disclosure to engineering context: keep default context small and load specialized guidance only when the task/path makes it relevant.

## Four layers

| Layer | Owner | Purpose |
|---|---|---|
| Always-on | root `AGENTS.md` | constraints relevant to nearly every task |
| Path-local | nearest scoped `AGENTS.md` | invariants owned by a subtree |
| Task-local | `.claude/skills/*/SKILL.md` | reusable workflow/decision process |
| Knowledge-local | `docs/`, Skill `references/`, code/Gates | detailed facts, rationale, inventories, executable truth |

Precedence:

```text
explicit user/task scope
  -> nearest scoped AGENTS.md
  -> parent/root AGENTS.md
  -> selected task Skill
  -> canonical docs/code/Gate facts
```

A Skill coordinates work; it does not override a path owner's invariant. A contradiction is an instruction-graph bug.

## Canonical filenames

`AGENTS.md` is canonical for root and scoped repository instructions.

Claude compatibility is always:

```text
CLAUDE.md -> AGENTS.md
```

Never maintain two editable copies.

## Skill-root decision

For this migration, physical Skill content stays under `.claude/skills` because existing Claude Code behavior and Nession changed-file routing already depend on that path.

Cross-agent discovery is exposed through:

```text
.agents/skills -> ../.claude/skills
```

Codex's repo-scope Skill loader follows directory symlinks and canonicalizes discovered paths, so it can consume the same Skill content from the standard `.agents/skills` surface without duplication.

This is intentionally a compatibility decision, not a claim that `.claude/skills` is the forever-standard location. A later move is allowed only if all path-sensitive routers are migrated in the same change.

## Placement rules

### Root AGENTS.md
Only information needed by nearly every task: product upstream sources, instruction discovery, one-owner discipline, worktree safety, Gate-first behavior, and Skill routing.

### Scoped AGENTS.md
Use when a subtree has durable invariants that should be learned by entering that owner. Do not add scopes merely to reduce root line count.

### Skills
A Skill answers “how do I perform this task?” Keep workflow, decision points, stop conditions, and links to owners. Put long inventories/rationale in `references/` or canonical docs.

### Docs / code / Gates
Durable architecture and rationale live in docs. Executable rule sets live in code/Gates. Prompt surfaces link instead of restating volatile lists.

## Adding guidance

Ask in order:

1. Is this executable? Put the rule at its code/Gate owner.
2. Is it path-specific? Put a concise invariant in the nearest scoped `AGENTS.md`.
3. Is it a repeatable task process? Put it in a Skill.
4. Is it detailed knowledge/rationale? Put it in docs or Skill references.
5. Is it needed by nearly every task? Only then add it to root `AGENTS.md`.

## Budgets

The instruction contract enforces:

- root `AGENTS.md`: <= 200 lines;
- main `SKILL.md` entrypoints: <= 320 lines;
- canonical/symlink relationships;
- unique Skill names and required descriptions;
- scoped compatibility links.

Budgets are regression guardrails, not targets to fill.

## Validation

```bash
node scripts/instruction-contract.mjs
node --test scripts/instruction-contract.test.mjs
./gates/run instruction-contract
```

Semantic duplication remains a review concern; the validator intentionally avoids brittle natural-language similarity checks.
