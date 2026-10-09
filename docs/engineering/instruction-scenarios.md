# Instruction Loading Scenarios — #1437

These scenarios prove the redesigned instruction graph by showing the minimal relevant load set and the canonical path to every required invariant. The goal is not “load fewer files at any cost”; it is “load no unrelated handbook while keeping required owners reachable.”

## 1. General feature/fix development

Load:

1. root `AGENTS.md`
2. `nession-development`
3. nearest scoped `AGENTS.md` for touched files
4. relevant Gate descriptions discovered through `gates/run`

Not required by default: CI/CD release runbook, Web Design, protocol architecture, acceptance.

Required constraints still reachable: read-only root/main, worktree workflow, one-owner rule, Gate-first verification, testing/PR flow.

## 2. Web UI / interaction change

Load:

1. root `AGENTS.md`
2. `web/AGENTS.md`
3. `nession-web-design`
4. relevant `docs/design/*`
5. design/Web Gates

Required constraints still reachable: product Vision/Principles, Web layer/import/state ownership, token/component/pattern ownership, browser proof, design Gate.

Unrelated runtime/release manuals are not required.

## 3. Protocol change

Load:

1. root `AGENTS.md`
2. `crates/nession-protocol/AGENTS.md`
3. `docs/architecture/protocol.md`
4. `nession-gates` only when Gate mechanics/repair is needed
5. protocol integrity + codegen Gates

Required constraints still reachable: Protocol Kernel ownership, versioned contract flow, generated-binding ownership, validation/codegen.

Web styling/CI release instructions are not required.

## 4. CI / workflow failure

Load:

1. root `AGENTS.md`
2. `.github/AGENTS.md`
3. `nession-cicd`
4. `nession-gates` only if the failure is a Gate/domain invariant

Required constraints still reachable: workflow-as-router rule, trust boundary, exact-head evidence, release/deploy ownership.

Subsystem implementation manuals are loaded only if the failing Gate points there.

## 5. Requirement Acceptance

Load:

1. root `AGENTS.md`
2. `nession-writing-requirements` when criterion/body structure changes
3. `nession-acceptance` for stage-specific proof
4. requirement-acceptance validator/Gate for deterministic merge/closure eligibility

Required constraints remain reachable without loading general development/CI manuals.

## 6. Code / architecture review

Load:

1. root `AGENTS.md`
2. `nession-code-review`
3. nearest scoped `AGENTS.md`
4. owner architecture doc and Gate evidence for the touched invariant

Examples:

- runtime/tmux review -> `crates/nession-agent/AGENTS.md`
- protocol review -> `crates/nession-protocol/AGENTS.md` + protocol architecture
- Web review -> `web/AGENTS.md`

The review Skill owns method/severity/evidence, not a copied textbook of every subsystem.

## Cross-agent compatibility evidence

### Claude Code

The physical Skill owner remains `.claude/skills`; existing Claude Code and Nession workflow paths therefore do not change. Root/scoped `CLAUDE.md` remain present as symlinks to canonical `AGENTS.md`.

### Codex

Codex discovers repo skills under `.agents/skills`. Its current host loader follows repo-scope directory symlinks and canonicalizes discovered Skill paths (see `openai/codex` `codex-rs/ext/skills/src/loader/host.rs` and `discovery.rs`).

Nession exposes:

```text
.agents/skills -> ../.claude/skills
```

so both tools resolve the same physical Skill content.

### Existing Nession automation

Issue-audit and repository workflows retain their existing `.claude/skills` paths. The migration intentionally avoids a simultaneous path-router cutover.

The Quality Gate's repository-tooling self-tests provide regression evidence that those automation entrypoints still initialize after the instruction migration.
