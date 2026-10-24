# GitHub Actions Agent defaults

The default Agent for **new** CI operations is selected in GitHub, not in a
committed workflow and not through a user-side CLI:

[Repository Actions Variables](https://github.com/BestNathan/nession/settings/variables/actions)

| Repository Variable | Example | Current consumer |
| --- | --- | --- |
| `AGENT_DEFAULT_REVIEWER` | `review-qwen-01` | `Agent / Review` and new `Acceptance / Agent Controller` requests |
| `AGENT_DEFAULT_ACCEPTOR` | `accept-qwen-01` | `Agent / SC Acceptance`, acceptance orchestrator, Post-Run Waker and new Controller requests |
| `AGENT_DEFAULT_AUDITOR` | `audit-qwen-01` | `Agent / Issue Audit`, including `/audit` comments |
| `AGENT_DEFAULT_DEVELOPER` | `dev-qwen-01` | Read/validated at Controller request; Qwen deliberately rejected until #2274 |

The registered IDs, roles, providers and credential Environment bindings live
in [automation/agents/registry.json](../../automation/agents/registry.json).
The trusted selection contract lives in
[scripts/lib/agent/default-routing.mjs](../../scripts/lib/agent/default-routing.mjs).
A non-empty unknown/wrong-role ID is an error, **never** an instruction to run
an arbitrary executable or fall back to Cursor.

Set each Agent's model, endpoint and credentials in its registered GitHub
Environment (Settings > Environments > select environment):

- `ANTHROPIC_MODEL` or role-specific `ACCEPTANCE_CLAUDE_MODEL` /
  `ISSUE_AUDIT_CLAUDE_MODEL`: an explicit Qwen model for Qwen paths.
- `ANTHROPIC_BASE_URL`: the approved Anthropic-compatible gateway endpoint.
- `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`: **Environment Secret**,
  never a repository variable or committed file.

For the currently registered Qwen identities, the Environment is
`dev-claude-qwen`. Several roles may share one credential Environment if
they share the same provider. Changing its `ANTHROPIC_MODEL` affects future
runs using that Environment; use separate Environments when different roles
need independent models. The configuration is read at job start, so a
previously running job is not retroactively reconfigured.

**Compatibility:** until a given Repository Variable is set, Review uses the
prior `review-qwen-01` default and the other supported entrypoints continue
their historical `cursor` Environment selection. The legacy
`ACCEPTANCE_PROVIDER` repository variable remains supported by the
acceptance orchestrator for migration. Explicit authorized workflow dispatch
inputs may select a registered alternative; invalid choices fail closed.

**Developer runtime pinning (incremental #2274):** a trusted, Store-admitted
Qwen Developer must pass `qwen-developer-policy.mjs` before invoking the
Provider. The binding contains registered Agent, exact source SHA, Qwen model,
canonical HTTPS gateway, pinned numeric Claude CLI version and restricted
native tools. Its SHA-256 Harness digest intentionally excludes credentials.
The native Resume verifier rejects source/model/CLI/Harness mismatches instead
of silently starting another model or session. The real Store-driven Qwen
Worker and cross-Run Resume remain **unimplemented**; this policy alone does
not activate `AGENT_DEFAULT_DEVELOPER=dev-qwen-01`.

**Durability:** the existing Issue-centric Developer flow currently executes
the specifically scoped Cursor-native #1997 Worker. The Controller reads this variable for new requests but refuses a Qwen Developer until #2274 is proven. Do **not** switch the Developer default to Qwen before then. Implement and prove
the Provider-neutral Developer execution, checkpoint and Resume path before
wiring `AGENT_DEFAULT_DEVELOPER` into that flow. Existing immutable Store
assignments are not changed by Repository Variables.

## Verify a change

1. Set one supported Repository Variable to a registered ID.
2. Run `Agent / Provider Smoke` in GitHub Actions to verify the Qwen gateway. The normal main-push/default manual smoke targets Qwen only; use `include_legacy=true` manually to test Cursor and DeepSeek compatibility when their quotas are available. Check the selected Environment, provider selection and verified result/telemetry.
3. To roll back **new** runs, restore the previous ID in the same GitHub
   Settings page; existing accepted Tasks retain their original assignments.
4. If the Environment is missing an API key, endpoint or the explicit Qwen
   model, the selected workflow must fail before model invocation. Never copy
   secrets into Issues, logs or telemetry.

This is runtime configuration, not a GitOps desired-state change; no
commit/PR/deployment is required for a later default change.
