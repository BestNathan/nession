# AI Workspace — State / Action Space / System One / View Protocol

Status: **design prototype, not a production API**. Owner: [Requirement #2221](https://github.com/BestNathan/nession/issues/2221). Scope: AI-specific interaction model only. This document is the canonical detailed protocol companion for the interactive [index.html](index.html). Nession's original Logical Workspace, Agent, Session, Git and Terminal owners are unchanged.

## 1. Concepts and ownership

| Name | Owner and invariant |
|---|---|
| `AIWorkspace` | One interactive workbench and a globally ordered, bounded collection of Scenes; owns focus and a versioned event/reducer lifecycle |
| `AIWorkspaceScene` | Stable `sceneId`, independently addressable work surface and internal navigation/operation state; not a backend domain Workspace or a React Tab |
| `AIWorkspaceCapability` | AI-addressable typed **semantic** operation declarations, predicates and permissions; does not own UI layout |
| `AIWorkspaceView` | Independently registered rendering/interaction binding, not a React component class; owns UI projection and local draft state |
| `AIWorkspaceRouter` | Pure deterministic resolution of user intent / typed action into existing view, embedded view, new scene, clarification or product handoff |
| `AIWorkspaceActionSpaceBuilder` | Pure, bounded derivation of available actions from current state, registered capabilities, actual resource facts and privileges |
| `SystemOneDecisionAdapter` | Narrow, replaceable typed-decision interface; Jev `choice/noul/score` supported; never executes mutations |
| `AIWorkspaceReducer` | The only UI transition writer; uses typed events, preconditions and revision controls; not a second Agent/Session state store |

**Business objects are not Scene objects.** A Scene may reference Agents, Sessions, repositories and other resources; closing/clearing a Scene never terminates one. Shared domain API, permissions, resource facts, headless UI and existing Terminal Runtime are reused via adapters.

## 2. Canonical state vs model projection

The browser holds canonical, immutable/reducer-owned state; only bounded semantic projections cross the model boundary. TypeScript-style conceptual schema:

```ts
type ResourceRef = { kind: 'agent'|'session'|'repository'; id: string };
type OperationStatus = 'idle'|'collecting'|'submitting'|'success'|'error';

interface AIWorkspaceStateV2 {
  schemaVersion: 2;
  revision: number;
  activeSceneId: string|null;
  scenes: AIWorkspaceScene[];
  pendingClarification?: { question: string; choices: string[]; ownerSceneId?: string };
  lastConfirmedOutcome?: {actionId:string; ownerSceneId:string; resource?:ResourceRef; status:'success'|'error'};
}
interface AIWorkspaceScene {
  sceneId: string;
  scopeKey: string;              // semantic reuse key, distinct from sceneId
  revision: number;
  rootCapabilityId: string;       // initial entry; not a permanent Scene type
  activeViewInstanceId: string;
  viewInstances: Array<{
    instanceId:string; capabilityId:string; viewId:string;
    viewRevision:number; viewMode:'list'|'detail'|'form'|'result';
    state:unknown;               // private view state, including drafts
  }>;
  context: {selected?:ResourceRef; resources?:ResourceRef[]};
  lifecycle:'active'|'background'|'suspended';
}

interface ModelProjection {
  schemaVersion:2; revision:number; activeSceneId:string|null;
  activeScene?: {
    sceneId:string; sceneRevision:number; currentView:string;
    selectedResource?:ResourceRef; pendingAction?:string;
    requiredSlots?:string[]; formDirty?:boolean; operationStatus?:OperationStatus
  };
  relevantScenes:Array<{sceneId:string;scopeKey:string;capabilities:string[]}>;
  visibleSelection?:{
    snapshotId:string; sceneId:string;
    orderedResourceIds:string[]; selectedResourceId?:string
  };
  lastConfirmedOutcome?:{
    actionId:string; ownerSceneId:string; resource?:ResourceRef; status:'success'|'error'
  };
}
```

Rules: draft **completeness** may be projected, secrets and actual terminal buffers are never included. The ordered resource IDs must reflect the exact filtered/sorted visible View, never an unfiltered backend list. If a user says “第二个” after filtering, resolve index 1 in the visible snapshot. If the snapshot/permission is stale or ambiguous, clarify; do not guess.

`AIWorkspaceState.revision` increments for meaningful committed UI transitions. Scene and View revisions advance on mutations to their own state. Irrelevant Scene revisions do not invalidate an independent decision; dependencies are captured with a fingerprint.

## 3. AI-specific Capability registry declarations

A registry entry separates these contracts, independent from existing Nession Workspace Capability internals:

- **Semantic**: stable `capabilityId`, `actionId`, input/output schema, target/scope requirements, risk/effect class, authoritative backend owner and availability predicate.
- **Presentation**: view binding, permitted `standalone|embedded|adaptive|handoff`, supported modes, host compatibility, user-visible labels, maximum optional presentation hints.
- **Instance**: `singleton|perScope|multiple`, stable semantic scope key, candidate matching, compatibility and draft preservation/consent.

Prototype defaults: `agent.list`: standalone/perScope; `session.list`: standalone/perScope; `session.create`: adaptive with nested Agent Scene View or independent Scene when necessary; `session.open`: handoff to canonical Terminal. Adding a safe registered View should not require branching on it in the global UI shell.

## 4. Legal Action Space generation

```ts
type ActionKind = 'navigation'|'interaction'|'mutation'|'handoff';
type Eligibility = 'enabled'|'needs_input'|'disabled';
interface ActionCandidate {
  candidateId:string; capabilityId:string; actionId:string;
  kind:ActionKind; eligibility:Eligibility; reason?:string;
  target:{sceneId?:string; viewInstanceId?:string; resource?:ResourceRef};
  placement:'standalone'|'embedded'|'adaptive'|'handoff';
  requiresConfirmation:boolean;
  preconditionVersion:string;
  label:string;
}
interface ActionSpace {
  revision:number; registryVersion:string;
  dependencyFingerprint:string;
  discovery:ActionCandidate[]; // globally discoverable actions
  contextual:ActionCandidate[];// currently selected scene/resource
  navigation:ActionCandidate[];// existing scene targets, no duplicates
}
```

Derive: registered → supported platform/view → admissible privileges → applicable resource/slots → `enabled|needs_input|disabled`; invalid actions are not model candidates for execution. Include global Discovery so an unopened capability remains reachable from natural language. Allow `needs_input` for opening a form, never for submitting it. A disabled action may still render explanatory affordance locally; **do not offer it as executable model candidate**.

Action IDs are Registry declarations, candidate IDs are request-scoped selectors, and resource IDs are authoritative handles. A candidate cannot assert authorization for its own execution.

**Three layers:** Eligible Actions (deterministic and safe), Contextual Actions (per Scene/View), Suggested Actions (optional model-ranked **subset** of eligible actions). Model rankings never grant access, invent candidates, bypass confirmation or reorder controls underneath a live click. Recommendations change presentation hints, not canonical business facts.

Re-derive ActionSpace synchronously on meaningful state/fact/permission changes, without waiting for System One. Recompute required fields on form edits but debounce/no-op the optional model recommendation path. A recommendation response itself must never trigger another recommendation (no feedback loop).

## 5. Intent + recommendation judgments

Two independently triggered kinds, both bounded:

1. `intent.resolve`: triggered on natural-language submission; match to a supplied action/target/placement candidate or `clarify`. A direct UI click bypasses this model.
2. `action.rank`: optional asynchronous recommendation following semantic events (selected Agent, confirmed creation, restored Scene). Rank only candidate IDs of eligible actions. This never navigates or mutates on its own.

A Nession client semantic envelope can carry `{schemaVersion,requestId,projection,utterance,actionSpace,dependencyFingerprint}`. Jev's **actual transport** is a *different*, provider-adapted `{model,state,questions}` body. Do not claim `{state,question}` is Jev's native HTTP schema. A thin authenticated Nession Server transport may forward a prevalidated `QuestionPlan` after provider adaptation; it must not silently change the user's utterance or decide Nession business actions. Control of what questions/actions are allowed remains in the versioned local/Server-approved registry contract.

**Jev `choice` example** (conceptual, mocked in HTML; field names follow Jev's typed question style):

```json
{
  "model":"jev-1.13.0",
  "state":{
    "utterance":"在这个节点创建 Session",
    "projection":{"activeSceneId":"scene-1","selectedAgentId":"agent-mac-02"},
    "actionSpaceRevision":7
  },
  "questions":{
    "requested_action":{
      "type":"choice",
      "instructions":"Which registered action best matches the utterance and current context?",
      "criteria":{
        "c0":"Open Session-create form on selected Agent within current Agent scene",
        "c1":"Open Session list",
        "none":"No unambiguous registered action matches"
      }
    }
  }
}
```

Map `c0/c1` to candidate IDs locally, never treat them as executable identifiers. Choice is one of predefined criteria; include a none/clarification option. Batch independent judgments only; if next-stage choices depend on the first judgment, use a second request. Enforce max candidate count and perform deterministic semantic narrowing prior to constructing questions. Version-pin Jev; evaluate Chinese/coreference quality and confidence thresholds offline; fail safe on provider outage.

### 5.1 AI Workspace semantic request and normalized decision

The following is a **proposed Nession-owned protocol**, intentionally distinct from raw Jev vendor fields. The frontend supplies an immutable snapshot **plus an allowlisted candidate selector table**. The Server validates authentication, request bounds, provider configuration and approved schema; its Provider Adapter constructs actual Jev `{model,state,questions}`. It does **not** execute Nession actions or autonomously decide layout.

```ts
type JudgmentMode = 'intent.resolve' | 'action.rank';
interface AIWorkspaceDecisionRequestV1 {
  schemaVersion: 1;
  requestId: string;
  judgment: JudgmentMode;
  utterance?: string;  // exact user text; required for intent.resolve
  projection: ModelProjection;
  registryVersion: string;
  actionSpaceRevision: number;
  dependencyFingerprint: string;
  candidates: Array<{
    candidateId: string; actionId: string; capabilityId: string;
    label: string; target?: {sceneId?:string;resource?:ResourceRef};
    kind: ActionKind;
  }>;
}
interface AIWorkspaceDecisionResponseV1 {
  schemaVersion: 1;
  requestId: string;
  judgment: JudgmentMode;
  sourceModel: string;               // pinned provider-resolved model
  registryVersion: string;
  actionSpaceRevision: number;
  dependencyFingerprint: string;
  outcome: 'resolved' | 'clarify' | 'unavailable' | 'error';
  selections: Array<{candidateId:string; probability?:number}>;
  providerUsage?: {inputTokens?:number}; // optional non-authoritative telemetry
  error?: {code:'TIMEOUT'|'UNAVAILABLE'|'INVALID_RESPONSE'|'LIMIT_EXCEEDED';retryable:boolean};
}
```

`selections` must be a list of **validated IDs from the exact submitted candidate map** (maximum one selected candidate for `intent.resolve`, bounded Top-K for `action.rank`). Neither a high score nor a `resolved` outcome is authorization to act. Caller re-derives eligibility and verifies expected versions before applying. No source-model output is persisted as authoritative business fact.

**Model adapter contracts:**
- Construct Jev Choice `criteria` from bounded `candidateId` → `c0,c1,...` labels/descriptions. Add `none`; keep the reverse lookup local to the decision request.
- For ranking, only include **enabled** action candidates. Use a version-pinned model and a separate typed ranking strategy; Choice probabilities over options are **relative probabilities**, not independent absolute relevance scores. Avoid treating a per-question `noul` as interchangeable with Choice confidence.
- Validate the vendor's returned choice or probability map and correlate `requestId`, model version and candidate IDs. Reject unknown IDs, malformed probabilities, size overflows, unsupported version and no-match; convert to a typed `clarify/error` result.
- Provider's raw request format is `{model,state,questions}`. Don't leak user provider credentials or transmit full local draft contents. Log only redacted, bounded Decision records and correlation identifiers.

**Server security boundary:** The browser's candidate list is *untrusted advice to the model*, not an authorization manifest. Server may validate the schema and approved capability/action identifiers against a shared versioned public manifest without owning client Scene layout. Backend Agent/Session APIs independently authorize any mutation at execution time. A crafted candidate list must not cause privileged actions to execute or make the Model Adapter accept arbitrary instructions as tools.

### 5.2 Response application and fallback

```ts
function acceptDecision(response, request, state, legalSpace) {
  if (response.requestId !== request.requestId) return 'discard';
  if (response.registryVersion !== legalSpace.registryVersion) return 'retry-or-clarify';
  if (response.dependencyFingerprint !== relevantFingerprint(state)) return 'discard';
  const candidate = legalSpace.eligible.find(c => c.candidateId === response.selections[0]?.candidateId);
  if (!candidate) return 'clarify';
  if (request.judgment === 'action.rank') return 'presentation-hints-only';
  return router.resolve(candidate, state); // still no mutation execute here
}
```

The actual fingerprint should include only dependencies used by this decision (active Scene, target, selection snapshot, permissions/facts, relevant dirty form and registry), not unrelated Scene revisions. The reducer applies result changes exactly once. Prevent stale responses from reviving deleted Scenes or overwriting a newer direct click.

| Failure / edge case | Required fallback |
|---|---|
| Jev request fails/times out | Keep current Scene/View, explicit UI retry; known buttons still work without model |
| No-match/ambiguous target | Ephemeral clarification near composer/current Scene; never allocate an empty Scene |
| Registered action becomes disabled | Cancel/reject decision and show changed availability |
| Form input is incomplete | Open/continue form; never auto-submit because a model selected `session.create` |
| Duplicate delivery/retry of mutation | Idempotency key + canonical backend result; do not create a second business Session |
| Recommendation arrives after another selection | Ignore stale recommendation; never steal focus or shift an active control |
| App switches to Standard while model request in flight | Keep both modes' state stable, discard stale AI focus writes |

### 5.3 UI transition events and execution ownership

Use typed reducer events as the **only UI state writers**. Prototype-aligned categories:

```ts
type AIWorkspaceEvent =
  | {type:'QUESTION_SUBMITTED';requestId:string;utterance:string}
  | {type:'MODEL_INTENT_ACCEPTED';requestId:string;candidateId:string}
  | {type:'MODEL_DECISION_DISCARDED';requestId:string;reason:string}
  | {type:'SCENE_FOCUSED';sceneId:string}
  | {type:'SCENE_OPENED';sceneId:string;scopeKey:string}
  | {type:'VIEW_ACTIVATED';sceneId:string;viewInstanceId:string}
  | {type:'RESOURCE_SELECTED';sceneId:string;resource:ResourceRef;visibleSnapshotId?:string}
  | {type:'VIEW_DRAFT_CHANGED';sceneId:string;viewInstanceId:string;field:string;value:unknown}
  | {type:'ACTION_PREPARED';sceneId:string;actionId:string;target?:ResourceRef}
  | {type:'ACTION_USER_COMMITTED';sceneId:string;actionId:string;idempotencyKey:string}
  | {type:'ACTION_RESULT_CONFIRMED';sceneId:string;actionId:string;resource?:ResourceRef}
  | {type:'ACTION_RESULT_FAILED';sceneId:string;actionId:string;code:string}
  | {type:'RESOURCE_FACTS_UPDATED';resource:ResourceRef;version:string}
  | {type:'RANKING_HINTS_ACCEPTED';sceneId:string;actionIds:string[]};
```

Derived `ActionSpace` is a computed projection, **not** another mutable state store. Recommendation hints may be stored as ephemeral presentation metadata but must not change eligibility or create business objects. User click events and accepted intent decisions may converge on `ACTION_PREPARED`; only `ACTION_USER_COMMITTED` crosses to a canonical backend mutation. Remote success/failure arrives as a separate authoritative event and changes subsequent actions.

## 6. Deterministic Router algorithm

A model answer may express `actionId/target/placementPreference`, but the Router owns all transitions:

1. Explicit **user** preference: current Scene, existing Scene, independent new Scene; validate vs registry policy. “新建 Session” is not “新建 Scene”.
2. Exact current-Scene instance & scope → update/restore its View.
3. Exact instance in another open Scene → focus and restore it.
4. Current Scene can host capability adaptively → embed View there.
5. Else permitted new Scene, or `handoff` to existing product surface.
6. Several valid non-equivalent targets, overwritten dirty draft, forbidden cardinality, unavailable capability → `clarification/unavailable` **without a new Scene**.

Direct clicks and model-resolved actions enter the same typed Router. Actions that change backend objects require separate user commit (and server re-authorization). The model may prepare a form/prefill verified slots but **never commit a mutation on its own**.

## 7. Event sequencing, dependencies, and stale results

```ts
interface DecisionContext {
  requestId:string; mode:'intent.resolve'|'action.rank';
  workspaceRevision:number; sceneId?:string; sceneRevision?:number;
  actionSpaceRevision:number; registryVersion:string;
  dependencyFingerprint:string; candidateIds:string[];
  visibleSnapshotId?:string;
}
```

Reducer is the only writer; update current Scene and View revisions on change. On a model response: verify candidate ID exists, registry/action policy unchanged, needed facts/permissions remain valid, target Scene still exists, referenced visible snapshot still matches, and no newer explicit user click/focus supersedes the decision. Reject/stale-discard and optionally retry with a new snapshot; **do not steal focus or overwrite drafts**. A workspace-wide revision mismatch may be benign if dependency fingerprint is unchanged.

For a backend mutation use `prepare → validate → user commit → idempotent execute → confirmed result`. Creation result must be established from the actual backend API response, with request/idempotency identity and failure handling. Recommendations may not self-trigger mutation or repeatedly schedule themselves.

## 8. Presentation and UI stability

Model output is **not** HTML, JSX, arbitrary React component names or CSS. Router produces a validated internal `PresentationPlan`:

```ts
interface PresentationPlan {
  scene:{sceneId:string; operation:'reuse'|'create'|'focus'|'handoff'};
  view:{instanceId:string; viewId:string; mode:'list'|'detail'|'form'|'result'; operation:'restore'|'open'|'update'};
  actionSlots:{primary?:string; secondary:string[]; overflow:string[]};
  focus?:{resourceId?:string;fieldId?:string};
}
```

Only registry-backed View IDs/modes/slots are accepted. Essential controls stay available independent of recommendations. Prefer no optional rerank while user is hovering/focusing/editing a control; avoid reordering buttons under pointers, replacing input DOM while editing, or mounting parallel Terminal runtimes. Standard mode and existing SessionRuntime stay intact. Clarification/errors live near the relevant composer/Scene, not as permanent empty Scenes.

## 9. Prototype contract (mock behavior only)

The HTML prototype must be runnable without credentials/network and expose:
- Empty centered composer → docked composer after first resolved Scene.
- AgentList / SessionList / SessionCreate Views; user click vs natural-language intent routes.
- Scene count/ID stability across Agent selection → embedded Create → draft → submit → result → back.
- Independent new Scene only for an independent context or user preference.
- Filtered visible list + “第二个” binding to actual filtered order.
- Action Space inspector, typed mock Jev QuestionPlan and chosen decision.
- Dynamic next-action suggestions after Agent selection and Session creation.
- Simulated invalid/offline action prevention, clarification without Scene, and stale decision discard.
- Standard↔AI switch preserving Scene state; opening a Session hands off to existing-style mock terminal.
- All records, decisions and commits are **mock**; no TypeSafe calls, backend mutation or real authorization. HTML verification is not production acceptance.

## 10. Acceptance cases (required evidence when implementing)

| Case | Expected invariant |
|---|---|
| Discover AgentList, select second visible filtered Agent | Correct selected resource according to visible ordered snapshot |
| Click Agent “+”, fill create draft, back, reopen, commit | Same Scene ID/count, draft preserved, success from mock API event |
| Natural-language “在这个节点创建” | No new Scene while compatible Agent Scene active |
| Standalone create with no compatible host / explicit independent Scene | New Scene only if Instance/Presentation Contract allows |
| Open SessionList twice / back to prior Scene | Reuse exact Scene, no duplicate |
| Confirmed Session created → open it | Last confirmed resource ID, handoff, no new Terminal runtime |
| Provider “unknown” / no match | Clarification, **no** clarification Scene allocated |
| Offline Agent / permission revoked | Submit rejected at execution boundary, action removed/disabled |
| Out-of-order model result after manual focus | Stale output discarded; no focus theft |
| Model-suggested next action | Ranking affects hints only; never auto-submit/execute |
| Register new fake capability | Discovery and Router work without hard-coded shell branch |
| Standard ↔ AI | Selected terminal and Scene state preserved |

## 11. Design-to-production boundary

This is a **design artifact in the one shared orphan-history `prototype` branch**; no production code or CI changes. Do not merge the earlier draft implementation PR #2222 as evidence of this protocol. Required implementation steps: deterministic core unit cases, provider adapter with pinned real Jev fixture evaluation, GitHub Case catalog admission, source-aligned browser acceptance, then product authorization.

References: [TypeSafe Jev official capabilities](https://typesafe-jev.com/en/capabilities/), [Issue #2221](https://github.com/BestNathan/nession/issues/2221), [Nession product model](https://github.com/BestNathan/nession/blob/main/docs/design/product-model.md).
