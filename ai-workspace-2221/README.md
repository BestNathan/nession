# Nession AI Workspace — State/Question/Action Space Prototype

**Requirement:** [#2221](https://github.com/BestNathan/nession/issues/2221) · **Protocol:** [PROTOCOL.md](PROTOCOL.md) · **Live design prototype:** [index.html](index.html)

The one shared orphan-history `prototype` branch contains the UI design assets. This directory is not an implementation PR and no Nession Server, System One gateway, Session API or Terminal runtime is contacted. **All Agent/Session data, judgments, rankings and API effects are mocked in-browser.**

## What is implemented in the prototype

- **AI Workspace → Scenes → registered Capability/View** vocabulary. Empty centered composer becomes a bottom-docked composer after a resolved Scene intent. Manual Scene carousel, stable Scene IDs, and Standard/AI mode switching.
- An AI-only **Capability Registry** with semantic, presentation and instance policies: AgentList and SessionList are scope-reused; SessionCreate is adaptive and stays **inside the Agent Scene** when initiated there; Session open performs a Standard-mode mock handoff.
- **Dynamic Action Space Builder:** derives Discovery, Contextual and existing-Scene Navigation candidates, `enabled/needs_input/disabled` eligibility, action kind (`navigation|interaction|mutation|handoff`) and revision/dependency fingerprint. Agent selection, form completion and confirmed creation all change its candidates.
- **Two model judgments (locally simulated):** natural-language `intent.resolve` uses a Jev-shaped `choice` QuestionPlan and an explicitly marked heuristic mock; `action.rank` gives deterministic illustrative scores to a subset of eligible non-mutation next actions. No actual model inference is performed.
- **Action ↔ State loop:** components handle clicks and drafts directly, update Scene state, rederive legal actions and refresh recommendations without requiring a model round-trip. A model suggestion **never directly submits a mutation**.
- **State inspector:** view structured v2 Scene projection, exact filtered visible Agent IDs and snapshot ID, current legal Action Space, Jev request mock, decision, next-action ranking and event timeline.
- **Temporal safety demo:** model decisions can be discarded when user navigation, selection or visible-list context changes during the simulated latency.
- **Clarification stays ephemeral:** unrecognized utterances do **not** create a meaningless Scene.
- **Confirmed-result handoff:** creating a mock Session updates the owning Scene's confirmed outcome and offers “打开刚创建的 Session”; Terminal remains a mock Standard surface, not a duplicated runtime.

## Suggested interaction sequence

1. Enter **「查看 Agent 列表」**. Inspect one Scene and its initial Action Space.
2. Select `macbook-pro`. The next-action recommendation changes to create Session.
3. Click the Agent row's **+**, or enter **「在这个节点创建 Session」**. The Scene ID and Scene count remain unchanged.
4. Fill a unique Session name and explicitly submit. Observe the confirmed mock result and `session.open` candidate.
5. Enter **「打开刚创建的 Session」**. The mock handoff switches to Standard mode; return to AI mode to recover the Scene.
6. Enter **「查看 Session 列表」**. An independent Scene is created. Repeating that command reuses it.
7. Return to Agent Scene, filter list to a subset and try **「选择第二个」**: the reference is resolved using **the currently visible filtered order**, not all backend Agents. An invalid index yields clarification.
8. Submit an unknown question: inspect the clarification without any additional Scene.

## Architecture constraints

The **five independent AI Workspace concepts** are `AIWorkspace`, `AIWorkspaceScene`, `AIWorkspaceCapability`, `AIWorkspaceView`, and `AIWorkspaceRouter`. Action Space Builder, Decision Adapter and Reducer are internal responsibilities. They do not rename or extend the existing Logical Workspace/Standard Workspace Capability registry. Reuse canonical domain services and existing Runtime through adapters; never duplicate authorization or backend resource ownership.

### Fidelity

The mock's local intent detection is deliberately **not** Jev and not a credible measurement of its Chinese accuracy. It constructs a Jev-shaped QuestionPlan for inspection and simulates the decision. `illustrativeScore` is **not** a measured model probability. The prototype is a conversation artifact; source-aligned integration Cases and actual browser/real-provider evaluation remain Pending in Issue #2221.

Development preview (external third party; cache may lag): https://raw.githack.com/BestNathan/nession/prototype/ai-workspace-2221/index.html

Pinned preview link in Issue #2221 uses a fixed commit SHA. GitHub Pages for Nession deploys trusted `main` only.
