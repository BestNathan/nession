---
name: nession-writing-requirements
description: Use when creating/updating Nession Requirement or Bug GitHub issues, documenting user requests, maintaining Success Criteria/Acceptance Report structure, labels, or conversation history.
---

# Nession Writing Requirements

This Skill owns **issue structure and requirement capture**. It does not own implementation, Gate semantics, or execution of acceptance.

**New Requirement authoring:** use `Success Criteria` for observable outcomes, `Acceptance Plan` for `when × branch/environment × method`, and a three-column `Acceptance Report` for `Result × Evidence`. **Do not duplicate Stage in new Reports.** Compatibility stages are derived from the Plan by `scripts/acceptance-plan.mjs`. Existing Issues without a Plan or with an explicit four-column Report remain unchanged. Production `when: deployed` requires separate authenticated deployment identity and is not inferred from a main merge.

See `docs/architecture/acceptance-sc-format.md` for canonical examples and migration rules. Issue lifecycle ordering (**Development Complete → Main Promoted → Regression Qualified → Released**) and the rule that ordinary Issue completion never waits for Main Full Regression are defined there and in `scripts/acceptance-lifecycle.mjs`.

- project knowledge impact -> [nession-knowledge](../nession-knowledge/SKILL.md); every new or materially revised Requirement records a `### Knowledge Impact` decision (`None | Read | Create | Update | Supersede`) with **Related knowledge**, **Reason**, **Owner and timing**, and **Evidence**. New Issues created from 2026-10-25 UTC are deterministically checked by `scripts/issue-contract.mjs`; historical Issues remain compatible. See `docs/engineering/knowledge-ledger.md`.
- interactive prototype delivery -> [nession-prototype](../nession-prototype/SKILL.md)
- implementation -> `nession-development`
- acceptance execution -> `nession-acceptance`
- Gate semantics -> `nession-gates`

The executable structural owner is `scripts/issue-contract.mjs`.

For new Issues, add **E2E Verification** with `### New` and `### Regression`; each contains a stable filename stem from `e2e/tests/**/*.spec.ts` or `- none: <specific reason>`. **E2E Report** has `ID | Type | Result | Evidence`; only trusted execution can mark Pass. Historical Issues lacking both sections remain supported. This is independent of the canonical v2 SC Acceptance Plan and Report.

Developer/Reviewer Agents may submit typed, auditable proposals using `scripts/issue-e2e-proposal.mjs` (Issue comment only). A trusted approval flow must validate the current declaration digest and exact head/base test catalog before adding new Pending obligations. Untrusted Agent Issue-edit tools may not alter required E2E IDs or result/evidence fields. Only `scripts/issue-e2e-gate.mjs` accepts authenticated exact-SHA proof. No permanent source-code→E2E mapping is maintained.



## Verification tiers and SC cost policy (canonical)

Every Requirement or Bug may have **exactly one** of:
- `verification:scoped` (L1, default for legacy unlabelled Issues): the affected Quality Gates, Issue-selected E2E IDs and source-aligned Acceptance, ordinarily at PR HEAD.
- `verification:integration` (L2): the above plus bounded, explicitly named cross-component Cases; merged-SHA checks only for invariants that genuinely require integration.
- `verification:full` (L3): a critical parent Requirement, major migration, security/release boundary or explicitly authorized system milestone; pin the **full-regression obligation to a specific milestone and SHA**. Do **not** propagate a parent's L3 to every child PR that only references it.

The Issue Audit Agent should assess scope, touched components, trust/security impact, failure recovery, protocol compatibility, release scope and the actual SC/E2E plan; give reasons for a proposed tier. A trusted main-owned verification policy, not mutable labels or LLM prose, controls execution. A GitHub label is not a signed test result, a permission to dispatch an AI Worker, or a bypass for required deterministic checks.

**Do not create boilerplate Success Criteria** requiring "merged SHA Full Quality + Full E2E + all Cases + Orchestrator green" for ordinary children. Default to `when: pr` and source-aligned relevant evidence. `when: merged` describes the point where a *specific invariant* becomes provable; it **does not imply Full E2E**. Only explicit L3 milestones require authenticated all-ID Full Regression. Missing or inapplicable Full Regression is `Not Required`, never a fabricated `Full Pass`. Preserve meaningful historical SC IDs and evidence; don't erase failed or pending results to relabel an Issue.

## SC proof timing: earliest safe boundary (mandatory authoring review)

Choose `when` from **where the invariant first becomes verifiable with authenticated
evidence**, not from where today's Worker happens to run. Before writing each
Acceptance Plan entry, ask what concrete observation proves the SC, whether it
needs credentials/external services, and why an earlier isolated boundary
cannot supply equivalent evidence.

| Proof needed | Earliest safe `when` | Typical `method` |
| --- | --- | --- |
| Parsing, validation, type/identity policy, source-specific regression, local isolated behavior | `pr` (exact PR head) | `agent` for read-only code/CI evidence; `case` when execution assertions are needed |
| Real cross-component, gateway, Store CAS, multi-Run recovery or failure injection requiring a trusted integration lane | `merged, branch: staging` (exact staging SHA) | `case` with an executed verifier and trustworthy receipts; `agent` only when assessing already-authenticated independent evidence suffices |
| A property **specific to main's** trusted dispatch identity, branch protection, final merge integration or main-only permission boundary | `merged, branch: main` (exact main SHA) | minimal targeted `case` or authenticated `agent` evidence |
| A behavior that depends on an actual deployed environment and revision | `deployed, environment: <lane>` | `case`, run explicitly through `Acceptance / Cases` `stage=deployed`; requires an authenticated deployment record for that environment and is never inferred from a main merge |

**Main-proof exception:** For every new `when: merged, branch: main` SC,
record in normal Requirement prose (not extra Acceptance Plan YAML keys):
(1) the exact main-only property, (2) why PR/staging evidence cannot prove
it, (3) the minimal Run/Artifact/SHA/Store observation needed, and (4) its
rollback or `Pending` policy. “Current workflow is main-only”, “CI is slow”,
“all suites green”, or “the implementation is not done yet” **are not reasons**.
A main smoke should target only residual main-specific risk, never re-run
every integration Case by default.

**Staging safety is a prerequisite, not a shortcut:** production GitHub
Environment secrets, signing keys, Store write credentials and privileged
`pull_request_target` authority must never be handed to a PR head or an
untrusted staging tree. Real provider/Store checks must use a trusted
main-owned executor, isolated staging credentials and Store namespace,
authenticated source Run/Attempt/SHA and a read-only result path; only the
canonical trusted ingester/projector may record Acceptance. If that lane
doesn't exist yet, declare the integration SC **Pending** with an explicit
staging-runner prerequisite. Implement the safe lane before accepting or
promoting the feature. Do not silently move the SC back to main or claim a
read-only model assessment is a real runtime Case.

For large workflows, split distinct proof boundaries into distinct,
stable SCs: e.g., PR fail-closed policy, staging real cross-Run recovery, and
minimal main dispatch receipt. Preserve existing SC IDs and historical
failures/results when amending a live Issue; explain the contract/stage change
in an Issue comment because its digest and prior evidence may no longer
apply. An open parent requirement does not automatically impose full-system
L3 or post-merge proof on each narrow child PR.

Issue `ai:enabled` remains a separate Worker execution authorization. Verification tiers never confer Worker or Store permissions.

## 1. Classify first

Choose exactly one kind:

- **Requirement** — requested product/engineering behavior/change.
- **Bug** — observed behavior contradicts the intended/current contract.

Use one or more area labels appropriate to the affected owner.

Before creating a new issue, search for an existing issue that already owns the same problem.

## 2. Issue lifecycle and dedupe

This Skill is the canonical owner of **reopen-vs-new issue decisions**, including findings produced by post-implementation review.

Before creating anything:

1. scan all open issues, not only one label;
2. inspect relevant closed issues;
3. compare the underlying invariant / Success Criterion, not only title keywords or symptoms.

| Existing state | Action |
|---|---|
| Existing issue owns the **same invariant / SC** and it is still unmet | **reopen that issue** (if closed) and add a post-implementation investigation comment |
| Existing open issue already owns the same invariant | comment/cross-reference there; do not duplicate |
| Same symptom but a **different confirmed root cause** | create a new Bug and reference the old issue |
| New independent behavior/design decision | create a new Requirement |
| Follow-up is already tracked elsewhere | link that issue from the parent/review issue |

When reopening, explain what the earlier implementation fixed, what invariant still remains false, and what evidence/Acceptance must change. Preserve the existing issue's Acceptance history instead of fragmenting one invariant across new issues.

Do not create a new Bug merely because an old issue is closed; closure state is not proof that its invariant is satisfied.

## 2a. Decide whether the Requirement needs an interactive prototype

For every **user-facing Requirement** or **Bug that changes a product interaction**, explicitly make a **prototype decision at Issue drafting time**—after dedupe and before treating the interaction contract as settled. The decision belongs to **this Skill**; creating, testing and publishing the artifact belongs to [nession-prototype](../nession-prototype/SKILL.md).

Do not treat "UI-related" as an automatic mandate to prototype every ticket:

| Decision | When to use | What to do |
|---|---|---|
| **Required** | The user explicitly requests a prototype; a **new interaction paradigm** or navigation/surface model; AI/intent-driven or dynamic components; multi-step flow with ambiguous state, placement, return/reuse, permission or confirmation semantics; substantial desktop/mobile behavior tradeoff; or two plausible UX designs need user validation | Record the open decisions and walkthrough; produce a clickable prototype **before relying on the design for production implementation or final product sign-off**, unless the product owner explicitly defers it |
| **Optional** | Existing UI pattern is mostly understood but a new visual composition or a localized interaction tradeoff would benefit from a quick hands-on comparison | State what decision the prototype would resolve; build if it changes product confidence or the user requests it |
| **Not needed** | No new user interaction (backend/CI/protocol/internal refactor); a precise, already-settled UI pattern; copy/spacing fixes or a narrowly reproducible bug adequately proven by existing tests/visual evidence | Record a short reason when UI-facing; proceed with the relevant development/design/Acceptance workflow |

Quick test: **Could two implementers satisfy the written Success Criteria with materially different user experiences?** If yes, prototype the disputed experience or specify it more precisely. A prototype is valuable for testing behavior, **not** for replacing a missing Requirement contract.

### Record the decision in the Issue

For UI/interaction issues, put a concise `### Prototype` subsection inside `## Requirements: ...` (or a small analogous section in a Bug's Description) with:

~~~markdown
### Prototype
- Decision: Required | Optional | Not needed
- Reason / interaction uncertainty: <specific question, or why unnecessary>
- Scenario to validate: <entry -> actions -> states -> expected result>
- Status: Planned | In progress | Reviewed | Deferred | Not needed
- Artifact: <immutable prototype branch SHA + source and browser preview once published>
- Fidelity / verification: <mock vs live; static/smoke/browser checks and gaps>
~~~

Before building a **Required** prototype, settle the Issue owner, observable interaction questions and representative Success Criteria. It is fine to create the Issue **first** and attach the prototype during discussion. Use [nession-prototype](../nession-prototype/SKILL.md) to create the actual artifact; the existing shared orphan `prototype` branch must **not** be mistaken for a production feature branch or PR head. If the product owner explicitly waives/defers an otherwise Required prototype, record **why**, what remains uncertain and how the behavior will be validated instead.

After publishing, replace placeholders with a **pinned immutable commit** source link and (first in the Artifact line) the **direct HTML Pages preview** `https://bestnathan.github.io/nession/prototypes/<topic>-<issue-number>/index.html`, if its HTTPS delivery and `prototypes/manifest.json` pinned SHA have been verified. Never present a GitHub blob/source viewer as the primary 'preview'. Put the source URL separately; if Pages is not published yet, say so rather than treating a constructed URL as verified. Include an honest mock/browser-fidelity note. Refresh the reference when the prototype changes. In production implementation Issues, **do not tick Success Criteria or mark Acceptance Pass based only on a mock prototype, screenshots, or parser smoke tests.** If delivering the prototype itself is an explicit requirement, give that deliverable its own observable SC and normal Acceptance Plan/Report ownership. Prototype evidence is design evidence; trusted production proof remains with `nession-acceptance`.

## 3. Requirement format

Title:

```text
Requirement: <concise outcome>
```

Body must contain the **canonical v2 authoring format**:

````markdown
## Requirements: <Topic>

<problem, desired behavior, constraints, design decisions>

### Success Criteria

- [ ] SC-01 <observable criterion>
- [ ] SC-02 <observable criterion>

## Acceptance Plan

```yaml
acceptance:
  SC-01:
    when: pr
    method: agent
  SC-02:
    when: merged
    branch: staging
    method: case
```

## Acceptance Report

| Criterion | Result | Evidence |
|---|---|---|
| SC-01 | Pending | awaiting exact PR head SHA Agent proof |
| SC-02 | Pending | awaiting merged staging SHA E2E Case proof |

## Product alignment

- [ ] Does this move Nession toward VISION.md?
- [ ] Does it obey PRINCIPLE.md?
- [ ] Were relevant docs/design/* sources checked?
- [ ] Is any deviation explicit?

---
**Status:** Draft | In Discussion | Approved
````

Every `SC-xx` has a stable ID, exactly one Plan entry, and exactly one Report row. Define the timing and proof method **once in the Plan**. The Report and SC checkbox are trusted projections, not alternative sources of proof configuration.

The Plan supports `when: pr | merged | deployed` and `method: agent | case`; `merged` requires `branch: staging | main`, while `deployed` requires `environment`. The runner compatibility stage derives from the Plan (`pr → pre-merge`, merged staging → staging, merged main/deployed → post-merge), **but a main merge is never production deployment evidence**.

Historical four-column Reports (`Criterion | Stage | Result | Evidence`) remain readable and must agree with a Plan if one is present. Historical three-column Reports without a Plan continue to mean `staging`; do not infer a new proof method for them. Do not rewrite old evidence merely to normalize Markdown.

Results are `Pending`, `Pass`, `Fail`, or justified `N/A`; infrastructure errors are separately recorded.

## 4. Good Success Criteria

A criterion states an externally verifiable outcome, not an implementation todo.

Good:

- exact behavior/state transition;
- compatibility or non-regression boundary;
- measurable UI/interaction result;
- deterministic validation evidence.

Bad:

- “code looks clean”;
- “refactor completed” without behavior;
- duplicating the implementation plan as checkboxes;
- ambiguous “works correctly”.

Use `post-merge` only when the criterion genuinely cannot be proven before merge/deploy/observation.

## 5. Bug format

Title:

```text
Bug: <observed failure>
```

Required sections:

```markdown
## Description
## Reproduction
## Root Cause
## Impact
## Fix Direction
## Location
```

If root cause is not verified, use `## Investigation Status` instead of `## Root Cause`. Never include both.

A Bug issue should distinguish verified facts from hypotheses.

## 6. Product alignment

For user-facing Requirements, read `VISION.md`, `PRINCIPLE.md`, and relevant `docs/design/*` before finalizing.

Do not use current implementation limitations as product requirements unless the constraint is intentional.

## 7. Conversation history

When requirements evolve, preserve meaningful decisions in an issue comment rather than repeatedly bloating the canonical body. Revisit the **Prototype** decision if interaction scope, product uncertainty or previously approved behavior changes; update its pinned artifact reference when a revised prototype is published.

Recommended comment:

```markdown
## Conversation History

### YYYY-MM-DD — Initial Request
**User:** ...

**Agent:** ...

### YYYY-MM-DD — Decision
...
```

The issue body should remain the current canonical requirement, not a chronological transcript.

## 8. Changes after creation

When the user changes a requirement:

1. update the canonical issue body (including the Prototype decision and pinned link if the interaction changed);
2. update/add affected SC rows;
3. preserve already-valid acceptance evidence only when the criterion meaning did not change;
4. add a conversation-history comment describing the decision;
5. keep Status accurate.

If criterion meaning changes materially, old evidence must not silently count as proof.

## 9. Acceptance relationship

This Skill defines criteria and report structure.

`nession-acceptance` executes stage-specific acceptance and updates evidence. The deterministic requirement-acceptance validator decides merge/closure eligibility.

Do not duplicate validator semantics here beyond the public table vocabulary.

## 10. Validate

Before considering an issue well-formed, run/use the canonical issue contract validator where applicable:

```bash
node scripts/issue-contract.mjs self-test
```

For an existing issue, use the repository's issue-audit workflow/tooling.

## Stop conditions

Do not finalize when:

- kind is unclear;
- there is no area owner;
- Success Criteria are implementation tasks instead of outcomes;
- Acceptance rows do not match SC IDs;
- a Bug root cause is stated as fact without evidence;
- product-facing behavior conflicts with Vision/Principles without an explicit decision.
