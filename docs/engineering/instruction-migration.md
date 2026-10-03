# Instruction Migration Matrix — #1437

Every large instruction surface is classified before removal. A duplicate is removed only after its destination owner exists.

## Former root CLAUDE.md

| Previous section | Class | Destination |
|---|---|---|
| Product Direction | always-on | root `AGENTS.md` linking `VISION.md` / `PRINCIPLE.md` |
| multi-agent compatibility | always-on | root `AGENTS.md` + instruction architecture doc |
| Project Structure / Architecture Flow | durable architecture | `README.md`, `docs/architecture/*`, scoped owners |
| Frontend Conventions | path-local | `web/AGENTS.md` + `docs/architecture/web.md` |
| Key Design Decisions / shadcn map | task/reference | `nession-web-design`, existing references |
| worktree Iron Laws / convention | task + minimal always-on | root invariant + `nession-development` |
| prerequisites / local development | task | `nession-env` + `nession-development` |
| Rust lint/toolchain details | executable/task | Cargo/clippy config + Gates + development Skill |
| tmux socket isolation/history | path-local + rationale | `crates/nession-agent/AGENTS.md` + checker/Gate + tmux docs |
| Docker / Kubernetes / CI/CD | task/path-local | `nession-cicd` + `.github/AGENTS.md` |
| development cycle / PR mechanics | task | `nession-development` |
| screenshots / Playwright | task | `nession-web-design` + development reference |
| release flow / version bump | task | `nession-cicd` |
| commit convention | task | `nession-development` |
| Quality Gates / hook details | executable/task | `gates/` + `nession-gates`; routing remains in hooks/workflows |
| requirement acceptance | executable/task | acceptance validator + requirements/acceptance Skills |
| design Gate live rule/profile details | executable/path-local | `design/scripts/design-gate.mjs` + `design/AGENTS.md` |
| local build-cache detail | durable reference | existing development reference |
| test-isolation detector detail | executable | checker/Gate; development Skill links |
| protocol Gate rule/history detail | durable/executable | `docs/architecture/protocol.md` + protocol Gate |
| coverage thresholds | executable | coverage scripts / Vitest config |

## Skills

| Skill | New entrypoint responsibility | Detailed owner/reference |
|---|---|---|
| nession-development | develop, verify, publish a change | env/Gates/Web Design Skills + development references |
| nession-cicd | CI, staging, release, deployment workflow | `.github/AGENTS.md`, workflow YAML, release reference |
| nession-code-review | review workflow, severity, evidence | scoped runtime/protocol guides + review reference |
| nession-writing-requirements | classify/write/update Requirement/Bug | issue-contract validator + template reference |
| nession-web-design | UI/design decision and validation workflow | `docs/design/*`, `design/AGENTS.md`, shadcn reference |
| nession-env | environment bootstrap/repair | tool-owned configs |
| nession-acceptance | stage-specific acceptance evidence | acceptance scripts/validator |
| nession-gates | Gate-first discovery/use/authoring/review | `gates/README.md`, checks/suites |

## One-owner decisions

- Worktree policy: root carries only the universal prohibition; workflow detail is in `nession-development`.
- Gate semantics: `nession-gates` + `gates/`; other Skills link.
- Release/staging: `nession-cicd`.
- Acceptance: `nession-acceptance` + validators; writing-requirements owns issue structure.
- Protocol: scoped protocol owner + architecture doc + executable validator.
- Web architecture: `web/AGENTS.md` + `docs/architecture/web.md`; Web Design Skill owns visual workflow.
- tmux: agent scope + checker/Gate; root no longer carries incident-level explanation.

## Compatibility

- Root/scoped `CLAUDE.md` are symlinks to canonical `AGENTS.md`.
- `.agents/skills` points to the existing physical `.claude/skills` owner.
- Existing Nession automation keeps its current `.claude/skills` paths, avoiding an unrelated router migration.
