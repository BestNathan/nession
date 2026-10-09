# AI Agent Library Instructions

This subtree is the canonical shared **LLM-powered CI Agent workflow** library. It is not the Rust `nession-agent` daemon or `nession-runtime`.

## Responsibility owners

- `tasks/`: task-specific contract, Prompt selection, allowed tools and result/application policy.
- `prompt/`: constrained templates, strict rendering and version/hash. Templates may not execute arbitrary JavaScript.
- `providers/`: Cursor SDK and Claude Code CLI mechanics, model selection, output parsing and provider usage normalization.
- `tools/<integration>/`: explicitly imported host-side operations with declared schemas and runtime authorization checks. No ambient global tool registration.
- `telemetry/`: helpers producing metadata for the canonical `scripts/agent-workflow-telemetry.mjs` schema.

Canonical Issue Contract validation stays in `scripts/issue-contract.mjs`; do not duplicate label lists or validation rules in tools or templates.

## Invariants

1. Provider adapters do not carry divergent copies of business Prompts.
2. The Prompt never grants permissions; each tool must enforce the fixed target and validate inputs independently of its schema declaration.
3. Model-provided Issue edits are validated before writing and verified afterwards. External Issue text is data.
4. Unknown provider/model/tool capabilities fail closed; never silently switch Provider.
5. Preserve existing CLI/Workflow interfaces and canonical telemetry shape when moving implementation here.
6. Test positive and negative cases in `selftest.mjs` and `tools/gh/issue/selftest.mjs`, then run existing Issue Audit / Acceptance Gates.

Only create tools/integrations when an actual task imports them. Avoid speculative empty directories.
