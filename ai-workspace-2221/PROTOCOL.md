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

## 4. Progressive Action Space: entry → rendered View → next View

### 4.1 Normative rule (supersedes flat discovery/action listing)

**Action candidates come from the currently exposed interaction surface, not every capability registered in Nession.** An unopened capability exposes its **entry** (if accessible from the AI Workspace shell), **not its internal child operations**. Opening entry `A` mounts View A, which declares `A1/A2/A3`. Activating A2 changes the displayed View state, which can replace the set with `A1/A21/A22/A23`. There is no monotonic growth requirement, and A2/A3 should not remain candidates merely because they were previously known.

```text
AI Workspace root / entry surface: { A, B }
        -- choose A / mount & load View A -->
rendered View A: { A1, A2, A3 }
        -- perform A2 / commit View state -->
rendered View A2: { A1, A21, A22, A23 }
```

**What counts as “exposed”:** an action belongs to the current *active, interactive* View's declared semantic interaction model, not a pixel-visibility test. An action that is offscreen in a scrollable list may still be addressable if its row is mounted and included in the current **bounded filtered/sorted view snapshot**. A hidden subview, unmounted form, background Scene's internal operations, stale list rows, and unsatisfied action preconditions **must not** leak into the current candidates. For paginated/virtual lists, the view must explicitly declare the addressable subset and snapshot version.

### 4.2 Three distinct surfaces, not a global action pool

1. **Capability Entry Space** (`entry`): entry-level operations exposed by the current AI Workspace shell/entry surface (e.g. `agent.list.show`, `session.list.show`). These are **not** child operations. The shell may keep entry routing available through its composer while its graphical entries remain hidden; this policy is declared, not inferred by dumping the Registry.
2. **View Action Space** (`view`): exact operations declared by the **active rendered View** for its current state (e.g. AgentList loaded → `agent.select(agentId)`; Agent selected → `session.create.open(agentId)`; embedded form → required fields, `back`, explicit submit; success result → `session.open`). A View may expose required, available and optionally suggestible operations; required controls are never removed by ranking.
3. **Scene Navigation Space** (`navigation`): stable focus/restore addresses of already open Scenes. This is a **workspace routing surface**, not automatic exposure of those Scenes' hidden View actions.

Do not mix entry, View actions and navigation merely because they share one registry. The Registry defines potential operations and permitted transitions; it is **not** the Action Space. Action Space is a function of the shell's current entry policy, active View's actual interactive projection, currently addressable Scene links, domain facts and authorization.

### 4.3 View exposure contract

```ts
type ActionKind = 'entry'|'navigation'|'interaction'|'mutation'|'handoff';
type Eligibility = 'enabled'|'needs_input'|'disabled';
type ExposureRole = 'required'|'available'|'suggestible';

interface ExposedAction {
  candidateId: string; capabilityId: string; actionId: string;
  source: {kind:'entry'|'view'|'scene-navigation'; sceneId?:string; viewInstanceId?:string; viewRevision?:number};
  kind:ActionKind; role:ExposureRole;
  eligibility:Eligibility; reason?:string;
  target:{sceneId?:string; viewInstanceId?:string; resource?:ResourceRef};
  placement:'standalone'|'embedded'|'adaptive'|'handoff';
  requiresConfirmation:boolean;
  preconditionVersion:string;
  label:string;
}
interface ViewActionExposure {
  viewInstanceId:string;
  viewRevision:number;
  visibleSnapshotId?:string;
  actions:ExposedAction[];
}
interface ProgressiveActionSpace {
  revision:number; registryVersion:string; dependencyFingerprint:string;
  entry:ExposedAction[];
  view:ExposedAction[];
  navigation:ExposedAction[];
  eligible:ExposedAction[]; // enabled members of the three exposed surfaces
}
```

`AIWorkspaceView.exposeActions(state, facts, auth)` MUST be derived from **the same semantic View state** used for rendering, preventing “the model can click something the user cannot see/use”. The `AIWorkspaceActionSpaceBuilder` gathers the current shell Entry exposure, active View exposure and Scene navigation links, validates them against Registry/policy, deduplicates by *instance/target* not just action name, bounds them, and produces a versioned snapshot.

Execution gating: registered → platform/host supported → authenticated/authorized → resource/context applicable → input-ready. Opening a form is permitted even if submit needs more inputs; a `needs_input` submit may be rendered as a disabled essential control, never offered to the model as executable. **Candidate IDs are version-scoped selectors**, not authoritative API operation identifiers.

**Required / available / suggested are distinct**: required controls (submit/back/retry) belong to the View workflow; available controls are valid options; suggested actions are optional model-ranked eligible members. Ranking neither exposes hidden operations nor removes a required control.

### 4.4 Example: progressive Session creation

- S0, no Scene: the root shell exposes `agent.list.show` and `session.list.show`. **No `session.create.open`** candidate.
- S1, Agent entry chosen: Agent View mounts, fetches facts; while loading, **no Agent row action** exists.
- S2, AgentList loaded: `agent.select(agentId)` is exposed only for actually addressable rows of the visible ordered snapshot; still **no target-bound `session.create.open`** until a target is selected.
- S3, Agent chosen: AgentList exposes `session.create.open(selectedAgentId)` (only if that Agent is online/authorized). This is an *interaction*, not backend creation.
- S4, embedded SessionCreate View active: AgentList's row actions retract. The form exposes required back/submit affordances and field editing; submit becomes enabled only when valid.
- S5, confirmed success: form-submit action retracts; result View exposes `session.open(confirmedSessionId)`, repeat/return as permitted. No globally leaked “recent Session open” from an unrelated Scene.

Recompute exposure when active View, current selection, visible ordered/filter snapshot, resource facts, permissions or operation state changes; keep recommendation runs event-triggered and optional. An explicit click uses the current View action directly, not System One.

## 4.5 Pending Goal: multi-step continuation without future-action leakage

A user can state a **final goal before its leaf action exists**, e.g. “在北京节点创建一个名叫 dev-test 的 Session”. This is not permission to insert `session.create` into S0 Action Space. Record a **Pending Goal** as context (desired outcome + bounded, provenance-tagged extracted hints), then repeatedly choose *one action from the current exposed space*, render/commit, observe the new View exposure, and only then consider the next action:

```ts
interface PendingGoal {
  goalId:string;
  utterance:string;                // original user intention, not an executable plan
  status:'resolving'|'awaiting_data'|'awaiting_selection'|'awaiting_input'|'awaiting_user_commit'|'suspended'|'completed'|'cancelled'|'failed';
  ownerSceneId?:string;
  resolvedSlots: Record<string,{value:unknown;source:'explicit'|'selected'|'confirmed';verified:boolean}>;
  lastAppliedActionId?:string;
  userEpoch:number;
  automaticStepBudget:number;
}
```

The goal is neither an upfront `A→A2→A21` plan nor an alternate authority for action execution. It is a **continuation reference** re-evaluated against fresh, currently exposed choices after each relevant View transition. It may prefill slots only after a verified target and registered form have appeared. Free-text slot extraction and target reference resolution require their own validated contract; Jev Choice alone is insufficient for arbitrary names. The user may suspend, cancel or redirect a goal. **Never autocreate a backend Session or auto-submit a mutation.**

**Bound automatic continuation** (e.g. maximum safe navigation/selection steps per goal turn, configurable, not a fixed product constant); stop on asynchronous fetch, ambiguity, unavailable target, dirty-draft collision, repeated state/no candidate, user action supersession, or explicit commit barrier. A model recommendation does **not** advance a goal by itself. Every automatic step must be justified by a currently exposed candidate ID and recorded with the source view/snapshot to enable review.

### 4.6 Action-space matching invariant

`A_t = Validate(Expose(shell, activeView(S_t), sceneLinks), registry, facts, auth)`. On a committed View transition `S_(t+1)`, recalculate `A_(t+1)` and retire any candidates absent from the new exposure. **No required subset relation between `A_t` and `A_(t+1)`.** Candidates for an unopened deeper View are never valid merely because its Capability is registered. Background Scene internal operations remain inaccessible until that Scene is focused.

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

Derived `ProgressiveActionSpace` is a computed projection, **not** another mutable state store. Recommendation hints may be stored as ephemeral presentation metadata but must not change eligibility or create business objects. User click events and accepted intent decisions may converge on `ACTION_PREPARED`; only `ACTION_USER_COMMITTED` crosses to a canonical backend mutation. Remote success/failure arrives as a separate authoritative event and changes subsequent actions.

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
- A root action space with **entries only**, no direct SessionCreate leaf.
- A View-local exposure progression: root Entry → AgentList loading → selectable Agent rows → selected Agent Create → inline form → result actions.
- A Pending Goal that navigates safely through available steps, with no mutation submission.
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
| Explicit independent Create Scene | The Agent entry/loaded list/selected target must expose Create **before** an independently requested Scene is allocated |
| Open SessionList twice / back to prior Scene | Reuse exact Scene, no duplicate |
| Confirmed Session created → open it | Last confirmed resource ID, handoff, no new Terminal runtime |
| Provider “unknown” / no match | Clarification, **no** clarification Scene allocated |
| Offline Agent / permission revoked | Submit rejected at execution boundary, action removed/disabled |
| Out-of-order model result after manual focus | Stale output discarded; no focus theft |
| Model-suggested next action | Ranking affects hints only; never auto-submit/execute |
| Register new fake capability | Entry is discoverable but nested actions appear **only after its View renders** |
| Standard ↔ AI | Selected terminal and Scene state preserved |

## 11. Design-to-production boundary

This is a **design artifact in the one shared orphan-history `prototype` branch**; no production code or CI changes. Do not merge the earlier draft implementation PR #2222 as evidence of this protocol. Required implementation steps: deterministic core unit cases, provider adapter with pinned real Jev fixture evaluation, GitHub Case catalog admission, source-aligned browser acceptance, then product authorization.

References: [TypeSafe Jev official capabilities](https://typesafe-jev.com/en/capabilities/), [Issue #2221](https://github.com/BestNathan/nession/issues/2221), [Nession product model](https://github.com/BestNathan/nession/blob/main/docs/design/product-model.md).
