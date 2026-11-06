# GitHub Actions Agent defaults

The default Agent for **new** CI operations is selected in GitHub, not in a
committed workflow and not through a user-side CLI:

[Repository Actions Variables](https://github.com/BestNathan/nession/settings/variables/actions)

| Repository Variable | Example | Current consumer |
| --- | --- | --- |
| `AGENT_DEFAULT_REVIEWER` | `review-qwen-01` | `Agent / Review` and new `Acceptance / Agent Controller` requests |
| `AGENT_DEFAULT_ACCEPTOR` | `accept-qwen-01` | `Agent / SC Acceptance`, acceptance orchestrator, Post-Run Waker and new Controller requests |
| `AGENT_DEFAULT_AUDITOR` | `audit-qwen-01` | `Agent / Issue Audit`, including `/audit` comments |
| `AGENT_DEFAULT_DEVELOPER` | `dev-qwen-01` | Default activation remains gated on #2274; explicit owner/main `developer=dev-qwen-01` canary is permitted for evidence |

The registered IDs, roles, providers and credential Environment bindings live
in [automation/agents/registry.json](../../automation/agents/registry.json).
The trusted selection contract lives in
[scripts/lib/agent/default-routing.mjs](../../scripts/lib/agent/default-routing.mjs).
A non-empty unknown/wrong-role ID is an error, **never** an instruction to run
an arbitrary executable or fall back to Cursor.

Set each Agent's model, endpoint and credentials in its registered GitHub
Environment (Settings > Environments > select environment):

- `CURSOR_MODEL` (and optional `CURSOR_MODEL_FAST`): the explicit Cursor
  model for `cursor`-provider instances.
- `ANTHROPIC_MODEL`: the explicit DeepSeek/Qwen model for generic
  `claude-code` paths.
- `ACCEPTANCE_CLAUDE_MODEL` / `ISSUE_AUDIT_CLAUDE_MODEL`: an optional
  role-specific override for the same gateway path; it is never used as a
  fallback default.
- `ANTHROPIC_BASE_URL`: the approved Anthropic-compatible gateway endpoint.
- `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`: **Environment Secret**,
  never a repository variable or committed file.

Model identity is resolved only from the selected GitHub Environment by
[scripts/lib/agent/providers/model-selection.mjs](../../scripts/lib/agent/providers/model-selection.mjs).
A missing or malformed model fails closed with no Provider or model fallback,
and the role workflows contain no hardcoded model name. Switching a model is
therefore an Environment-only change; no Git diff is involved.

For the currently registered Qwen identities, the Environment is
`dev-claude-qwen`. Several roles may share one credential Environment if
they share the same provider. Changing its `ANTHROPIC_MODEL` affects future
runs using that Environment; use separate Environments when different roles
need independent models. The configuration is read at job start, so a
previously running job is not retroactively reconfigured.

**Compatibility:** until a given Repository Variable is set, Review uses the
prior `review-qwen-01` default and the other supported entrypoints continue
their historical `cursor` Environment selection. The `cursor` and `deepseek`
Environments must supply `CURSOR_MODEL` and `ANTHROPIC_MODEL` (plus the
role-specific model override where the historical path needs one) for those
legacy selections. The legacy `ACCEPTANCE_PROVIDER` repository variable
remains supported by the acceptance orchestrator for migration. Explicit
authorized workflow dispatch inputs may select a registered alternative;
invalid choices fail closed.

**Developer runtime pinning (incremental #2274):** a trusted, Store-admitted
Qwen Developer must pass `qwen-developer-policy.mjs` before invoking the
Provider. The binding contains registered Agent, exact source SHA, Qwen model,
canonical HTTPS gateway, pinned numeric Claude CLI version and restricted
native tools. Its SHA-256 Harness digest intentionally excludes credentials.
The native Resume verifier rejects source/model/CLI/Harness mismatches instead
of silently starting another model or session.

## Qwen Developer runtime, evidence and activation (#2274)

The main branch now contains the **implementation** of the signed production
Qwen path, but **not proof of its activation**. These are deliberately distinct:

1. `Agent / Development` runs an isolated, registered
   `dev-qwen-01` Claude Code CLI Worker with the pinned Qwen model,
   a bounded Read/Edit/Write policy, a real exact-SHA Git patch and canonical
   Agent telemetry. The model never receives Store Writer, Controller or
   Publisher GitHub credentials.
2. The existing `Store / Agent Development Ingest` authenticates the original
   GitHub Run, signed Claim and both Artifact ZIPs, then commits a Qwen-native
   RSA/AES ciphertext checkpoint with a real Store CAS and immutable Run
   receipt. A separate trusted pre-model step restores the same native Session
   on a later signed Run; incompatible model/CLI/source/repair lineage is
   rejected rather than silently creating a new Session.
3. The main-owned `Store / Qwen Publisher` workflow is woken only by a
   successful authenticated Qwen Ingest. It independently verifies the
   source SHA, actual Git patch and immutable native Store receipt, persists a
   write-ahead publication Intent **before** the first GitHub write, then
   creates one branch/PR through a separate Publisher App. A replay performs
   read-only reconciliation rather than resending an ambiguous POST. PR HEAD,
   parent commit and changed file blobs are verified before the existing
   Store/Outbox owner retires the Developer Action and creates one Reviewer
   dispatch. Historic #1997 Cursor flows are left unchanged.

**Do not conflate green CI with real Qwen runtime Acceptance.** The older
staging #2319 fixture proves a signed Qwen *synthetic* edit and real
cross-Run native Resume, but does **not** exercise the entire #2274 production
Worker→Store→Publisher→Reviewer chain. The following #2274 evidence is still
required before enabling the Developer default:

- SC-02 and SC-03: merge an exact target to staging, then independently record
  a real registered Qwen Developer Run/Attempt with an actual source patch,
  native Store commitment and canonical telemetry, followed by a **different**
  authenticated Run restoring exactly the same Session UUID. Evidence must be
  bound to that merged staging target, not simply the earlier #2319 canary.
- SC-05: verify an actual owner/main signed Outbox dispatch through real Qwen
  Worker, independent Store receipt, trusted Publisher PR and Reviewer/Repair
  handoff. A saved deterministic Gate fixture alone is not runtime proof.

To prepare a restricted runtime rollout, verify the GitHub Environments:

| Boundary | Required configuration |
| --- | --- |
| `dev-claude-qwen` model Worker | Explicit `ANTHROPIC_MODEL` (Qwen), approved `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, numeric `CLAUDE_CODE_VERSION`, public-only `QWEN_RESUME_PUBLIC_KEY_B64` |
| Trusted Store Ingest / native Restore | Existing scoped Store Writer App and AES key seed; matching `QWEN_RESUME_PRIVATE_KEY_B64` available to the trusted job, never inside the model container; the historical Cursor key remains independent |
| Trusted Publisher | Separate Publisher App with repository-scoped Contents and Pull Request write permissions, and the independently scoped Store Writer App; no provider credential or model invocation |

**Restricted owner/main Qwen canary:** the Controller may initialize a
new, separate open fixture Issue only when the owner explicitly enters
`developer=dev-qwen-01` in a trusted `Acceptance / Agent Controller`
workflow_dispatch, with an exact main-ancestor source SHA. The separate
Store Ingest must still authenticate the Request Run/Artifact and commit
the immutable Issue state before the signed Outbox may dispatch a Worker.
No Provider, Issue body or model can invoke this route on its own.

Configuring `AGENT_DEFAULT_DEVELOPER=dev-qwen-01` **without an explicit Qwen
override remains fail-closed** until #2274 real staging/main evidence passes.
The controlled canary grants no privileged model credentials, migration of
a Cursor checkpoint, PR self-merge or SC Pass. Once the authentic staging
Cases and main handoff are accepted, the owner may enable Qwen by changing
the GitHub Repository Variable; existing immutable Store assignments and
historical Cursor Sessions remain unchanged.

The exact runtime/Acceptance status is tracked by
[Issue #2274](https://github.com/BestNathan/nession/issues/2274); no
documentation statement can substitute for a successful authentic Run.

## Verify a change

1. Set one supported Repository Variable to a registered ID.
2. Run `Agent / Provider Smoke` in GitHub Actions to verify the Qwen gateway. The normal main-push/default manual smoke targets Qwen only; use `include_legacy=true` manually to test Cursor and DeepSeek compatibility when their quotas are available. Check the selected Environment, provider selection and verified result/telemetry.
3. To roll back **new** runs, restore the previous ID in the same GitHub
   Settings page; existing accepted Tasks retain their original assignments.
4. If the Environment is missing an API key, endpoint or the explicit model
   variable, the selected workflow must fail before model invocation. Never
   copy secrets into Issues, logs or telemetry.

This is runtime configuration, not a GitOps desired-state change; no
commit/PR/deployment is required for a later default change.
