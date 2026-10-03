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


## Previous Skill section matrix

This is the section-level classification used for the Skill rewrite.

| Skill | Previous major sections | Destination after migration |
|---|---|---|
| nession-development | Overview; root/worktree/branch Iron Laws; Worktree workflow | concise development entrypoint; root keeps only universal read-only-main rule |
| nession-development | Local Development; tests; Testing Gates; error reporting; test DB | development entrypoint + executable Gates/checkers; environment setup moves to `nession-env` |
| nession-development | Version Bumping; Development Cycle; PR Workflow | development entrypoint delegates release-specific policy to `nession-cicd` |
| nession-development | Playwright Functional Verification | `nession-web-design` owns browser/visual workflow |
| nession-development | Batch Development by Label; Quick Reference; Common Mistakes | concise batch/stop conditions in development entrypoint |
| nession-cicd | Overview; Deployment Monitoring; Iron Laws | CI/CD entrypoint + root/development link for worktrees |
| nession-cicd | Development Flow; release staging->main; merge strategy | CI/CD entrypoint; live workflow files remain executable truth |
| nession-cicd | ArgoCD/GitOps; version bump; direct-to-main; main/staging movement | CI/CD entrypoint + `.github/AGENTS.md` + workflow owners |
| nession-cicd | Requirement Acceptance; issue auto-close | `nession-acceptance` + deterministic validator; CI/CD only routes it |
| nession-cicd | Pipeline architecture; troubleshooting | CI/CD entrypoint uses failing boundary classification and live workflows |
| nession-code-review | review modes; baseline; invariant; data path | concise review entrypoint |
| nession-code-review | concurrency checklist; lifecycle/reconnect | review entrypoint + nearest runtime scoped owner |
| nession-code-review | protocol review | `crates/nession-protocol/AGENTS.md` + `docs/architecture/protocol.md` |
| nession-code-review | tests-as-proof; issue comparison; severity; evidence | concise review entrypoint |
| nession-code-review | issue lifecycle; fix ordering; Nession-specific heuristics | owner-specific guidance + concise stop/output workflow |
| nession-writing-requirements | classify; hard rules; automated audit | concise issue-authoring entrypoint + `scripts/issue-contract.mjs` |
| nession-writing-requirements | executable acceptance | `nession-acceptance` + acceptance validator |
| nession-writing-requirements | Requirement body/commands/conversation history | concise canonical templates/workflow |
| nession-writing-requirements | Bug path; labels; lifecycle; edge cases | concise canonical bug workflow + issue validator |
| nession-web-design | purpose/trigger/owner/progressive reading | concise Web Design entrypoint |
| nession-web-design | layer model | `web/AGENTS.md` + `docs/architecture/web.md` |
| nession-web-design | token/component/shadcn decisions | design entrypoint + `design/AGENTS.md` + existing shadcn reference |
| nession-web-design | primitive/pattern/layout/extension | `docs/design/*` + concise decision workflow |
| nession-web-design | third-party boundary; validation/browser/failure loop | concise Web Design entrypoint + executable design Gate |
| nession-web-design | task recipes/checklist | collapsed into decision flow/completion criteria |
| nession-env | languages/CLI tools/plugins/MCP/one-shot setup | concise environment bootstrap using repository version/config owners |
| nession-env | Common Issues | generic missing-prerequisite diagnosis order; tool-specific truth remains with tool/config |
| nession-acceptance | lifecycle/run/contract/result/verification | retained as a small dedicated acceptance workflow |
| nession-gates | Iron laws; start every change; normal workflow; failure reading | concise Gate entrypoint |
| nession-gates | is-this-a-Gate; authoring; suites; routers | concise Gate entrypoint + `gates/README.md` live mechanics |
| nession-gates | quality-system changes; code review; acceptance relation | concise Gate entrypoint linking other owners |
| nession-gates | quick table/relationships | removed as duplication; task routing lives in root and owners |

No previous major Skill section is intentionally left without a destination.
