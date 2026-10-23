# Nession AI Workspace — State/Question/Action Space Prototype

**Requirement:** [#2221](https://github.com/BestNathan/nession/issues/2221) · **Protocol:** [PROTOCOL.md](PROTOCOL.md) · **Live design prototype:** [index.html](index.html)

The one shared orphan-history `prototype` branch contains the UI design assets. This directory is not an implementation PR and no Nession Server, System One gateway, Session API or Terminal runtime is contacted. **All Agent/Session data, judgments, rankings and API effects are mocked in-browser.**

## What is implemented in the progressive prototype

- **Entry-only root Action Space:** the AI Workspace shell exposes Agent/Session **capability entries**, **not** a global leaf-action catalog. In particular there is no root-level `session.create.open`.
- **View-owned actions:** an AgentList in loading state exposes no row actions; after actual View data is loaded, only its currently filtered/ordered Agent rows are model-addressable. Selecting an Agent exposes its contextual SessionCreate action; opening the embedded form **retracts** its Agent row actions.
- **Action replacement after business confirmation:** the form's submit action is available only when valid. After mock Session creation, submit is retired, and the result View exposes an `Open Session` handoff. No background Scene's hidden leaf actions leak into the active Scene.
- **Pending Goal continuation:** a single utterance such as “在北京节点创建一个名叫 dev-test 的 Session” follows successive **currently exposed actions**: Agent entry → loaded Agent row → contextual create View → **explicit user commit barrier**. No action is pre-exposed at root and no Session is automatically created. Missing target pauses for user selection. Explicit requests for an independent Scene are honored only after the Create action has been exposed.
- **System One simulation:** the inspector shows dynamically derived Action Space and Jev-shaped `choice` QuestionPlan; the actual judgment uses a **local heuristic mock**, and next-action scores are illustrative. No external Jev/model inference occurs.
- **Continuity:** stable Scene ID across embedded View transitions, form draft retention, explicit submit, confirmed-result handoff, bounded goal steps, stale model result rejection after form edits, local Standard/AI mode switching.
- **Strict ownership:** Agent/Session records, server permissions, backend mutations and Terminal handoff remain **mocks**. `AIWorkspace`, `AIWorkspaceScene`, `AIWorkspaceCapability`, `AIWorkspaceView`, `AIWorkspaceRouter` are AI-specific concepts independent from old Logical Workspace and Standard UI registries.

## Suggested interaction sequence

1. Enter **「查看 Agent 列表」**. Inspect one Scene and its initial Action Space.
2. Select `macbook-pro`. The next-action recommendation changes to create Session.
3. Click the Agent row's **+**, or enter **「在这个节点创建 Session」**. The Scene ID and Scene count remain unchanged.
4. Fill a unique Session name and explicitly submit. Observe the confirmed mock result and `session.open` candidate.
5. Enter **「打开刚创建的 Session」**. The mock handoff switches to Standard mode; return to AI mode to recover the Scene.
6. Enter **「查看 Session 列表」**. An independent Scene is created. Repeating that command reuses it.
7. **Clear the UI workspace**, then enter **「在北京节点创建一个名叫 dev-test 的 Session」**. Inspect Pending Goal steps: Agent entry → visible Beijing row → newly exposed Create action. The form pre-fills the name but **does not submit**.
8. Clear again, enter **「创建 Session」** with no target: Agent View opens and awaits your selection; choosing a row resumes the Pending Goal.
9. Return to Agent Scene, filter to a subset and try **「选择第二个」**. It must reference only the current filtered row snapshot; invalid ordinals clarify.
10. Submit an unknown question: clarification creates no additional Scene.

## Reproducible mock smoke checks

Run `node ai-workspace-2221/smoke-test.mjs` from the shared `prototype` branch checkout (or `node smoke-test.mjs` from this directory). It has **no npm dependencies** and reads the checked-in `index.html`. The script exercises **47 local JavaScript event/state invariants**: Scene reuse, discovery candidates, filtered ordinal resolution, contextual recommendations, disabled offline Agent, in-flight stale-decision discard, inline create/draft/confirmed result, next-action handoff and Standard/AI continuity. The script does not start Chromium, contact TypeSafe or run real backend APIs, and is **not** production Acceptance evidence.

## Goal advancement state-machine refinement

The original 12-call real Jev diagnostic reached **10/12**, missing only the two **root Session-create goals** (it chose `none` instead of opening Agent). The [protocol §4.7](PROTOCOL.md) corrects the question to **select one currently exposed action that advances the final goal** rather than insist on exact final-action matching. This changes **decision semantics**, not View exposure: the root still has no Create leaf.

The prototype now uses an explicit validated PendingGoal transition graph, records transition causes, and pins source View revision and Action Space fingerprint per applied goal step; it avoids repeating the same candidate for an unchanged snapshot, waits when no candidate is available, and preserves the original Goal across explicit form-slot updates such as **「名称叫 dev-test」**. An unrelated user intent suspends the old Goal; returning to its Scene and saying **「继续」** restores the unfinished form without replaying earlier operations. The backend mutation remains explicitly user-committed.

`smoke-test.mjs` runs **47 local mocked event/state checks**; it does not prove real Jev, Chromium rendering, or Nession backend execution. Live provider measurements must be reported separately.

**Real Jev follow-up evidence:** [immediate-match vs progressive prompt experiment](https://github.com/BestNathan/nession/actions/runs/39908609159) was 3/5 vs 4/5; the progressive prompt fixed initial creation routing but falsely selected Agent for poetry. [Relevance-gated progressive test](https://github.com/BestNathan/nession/actions/runs/39908810295) was **10/10** on a fixed root-positive/negative sample. These are small distinct evaluations; neither establishes production accuracy, backend authority or SC acceptance.

## Architecture constraints

The **five independent AI Workspace concepts** are `AIWorkspace`, `AIWorkspaceScene`, `AIWorkspaceCapability`, `AIWorkspaceView`, and `AIWorkspaceRouter`. Action Space Builder, Decision Adapter and Reducer are internal responsibilities. They do not rename or extend the existing Logical Workspace/Standard Workspace Capability registry. Reuse canonical domain services and existing Runtime through adapters; never duplicate authorization or backend resource ownership.

### Fidelity

The mock's local intent detection is deliberately **not** Jev and not a credible measurement of its Chinese accuracy. It constructs a Jev-shaped QuestionPlan for inspection and simulates the decision. `illustrativeScore` is **not** a measured model probability. The prototype is a conversation artifact; source-aligned integration Cases and actual browser/real-provider evaluation remain Pending in Issue #2221.

Development preview (external third party; cache may lag): https://raw.githack.com/BestNathan/nession/prototype/ai-workspace-2221/index.html

Pinned preview link in Issue #2221 uses a fixed commit SHA. GitHub Pages for Nession deploys trusted `main` only.
