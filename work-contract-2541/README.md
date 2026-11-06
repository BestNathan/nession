# WorkContract interaction prototype — #2541

## Scenario contract

- **Requirement:** https://github.com/BestNathan/nession/issues/2541
- **Product surface:** **Work is one Workspace capability** using the existing Nession capability-provider/ViewBinding and WorkspaceShell/CapabilityCapsule presentation model. WorkContract is its domain entity. No independent Work page, top-level Work route or mandatory Shell Session tab. Existing Files/Git capabilities and Terminal return remain separate.
- **Product baseline:** main `VISION.md`, `PRINCIPLE.md`, `docs/design/product-model.md`, `docs/design/visual-language.md`, `docs/design/interaction/web.md`, `docs/design/workspace.md`, `web/src/app/workspace/WorkspaceShell.tsx`, `design/generated/web.css` semantic variables. Presentation uses shared `../prototype-frame-2758/frame.css` and `frame.js`. Native product rendering is approximated by plain HTML/CSS.
- **Decision:** WorkContract is the **single** work-domain noun replacing WorkItem. Published revisions are immutable definitions; criteria belong to a revision; Thread/Execution/Verification are associated mutable records. GitHub Issue/Feishu/DingTalk are source adapters, not Contract identities.
- **Design question:** Is it visually obvious that Work is one contextual Workspace capability rather than a new product surface? Can users return from Contract detail to Work list, switch Workspace capabilities without losing Contract context, and distinguish pinned published Contract from source changes, proposals, Thread and verification?

## Entry → full flow

1. Open **Workspace**. Its bottom capability capsule shows contextually available Files / Git / Work; Work is a capability view. Select Work and open its contract **Terminal reconnect content mismatch** (sanitized invented fixture). No new global Work destination.
2. Read v1 published definition and its goal/constraints. Open **Criteria**; each SC shows its immutable wording and separate author checkbox vs trusted verification outcome.
3. Open **Thread** and add a mock comment. The comment is appended to activity, but the published definition/revision stays exactly the same.
4. Review **Source** to see an authorized GitHub Issue binding (real URL pattern but invented content). Switch external fixture to **Source changed**: a pending candidate v2 appears; review its proposed criterion difference. Explicitly choose **Compare revisions** or **Review proposal** and then **Adopt v2 (mock)** via confirmation. The button does **not** write GitHub, publish knowledge or dispatch Agents.
5. Navigate back to v1 in **Revision history** to confirm old definition remains available. Any execution/evidence shown remains pinned to v1; v2 has no magically inherited Pass.
6. Switch fixtures to **Access denied**, **Source unavailable**, **Feishu fixture**. Verify explanations, read-only fallback, and no silent migration or privileged behavior.
7. Switch to Files or Git in the same **Workspace Capsule**, then back to Work: the selected Contract, tab and revision survive. Web uses the separate **Terminal** surface destination; App Back goes **Contract detail → Work capability list → Terminal**. Workspace capability capsule remains at every depth.
8. Select **No Work binding**. Work disappears from the Capsule when unavailable; if it was already selected, it shows a scoped unavailable explanation without a dead entry. Other capabilities and Terminal still work.
9. Change preview from Web 1180/1024 to App 430/390/375. True CSS pixel viewport, no zoom/scale; external review controls stay outside product.
10. **Reset** replays the initial Workspace → Work list state.

## Surface / responsive

- **Workspace capability root:** `WorkspaceShell` owns the content slot and bounded bottom capability capsule, while the Work capability owns only its internal Contract list/detail and local navigation. A mock Files/Git stub exists solely to prove Workspace capability switching; it is not a copy of those production views.
- **Web:** Work fills the current capability content region with restrained detail and context. **Open Terminal** sits separately from the Capability Capsule as a surface action, not a Work-owned route/header.
- **App:** Workspace work content uses pushed detail/back semantics; the capsule remains accessible at all depths. On Contract detail, Back returns to Work list first, then to the Session/Terminal surface. No Work-owned app header or separate global navigator.
- Shared review frame sets real CSS pixel widths without zoom/scale; product listens to bubbling `np:resize` and toggles mobile composition at <= 600px.
- Accessible buttons, logical headings, visible focus, scrollable panels and feedback are part of the interactive fixture.

## Fidelity and non-goals

- **Mock only:** contract revisions, criteria, comments, external source, digest, adoption flow, permissions, source errors, account, API and Agent execution are deterministic in-memory fixtures. There is no actual network request, authentication, persistence or live Agent/Acceptance/GitHub/Feishu call.
- **Source binding identity:** `github:github.com:example/nession:issue:42` is a fabricated demo identity showing namespacing; `wc_demo_terminal` is a separate Contract identity, not a production allocation algorithm.
- **Verification authority:** a tick is author-authored text. The prototype never invents a trusted Pass from checkbox or a new contract revision from comments.
- **Candidate vs published:** review/adopt is simulated to explore workflow. Real write/approval permissions and a canonical Contract store are deferred domain decisions, not implemented by this prototype.
- **Visual fidelity:** local snapshot of Nession's neutrals and semantic roles rather than exact shadcn/React, live Workspace composition or active Sessions. Neither pixel-perfect matching nor working production route claimed. Compare against current production fixture in Chromium before accepting a UI implementation.
- **Non-goals:** create/edit external GitHub Issue, real Feishu/DingTalk APIs, Agent dispatch, trusted Acceptance result, a new persistent global Work nav, actual production capability registration, document AST editing.

## Test and publication status

- **Critical placement regression:** Work is a contextual Workspace capability entry, not an independent destination. The mock Workspace Capsule owns the Files/Git/Work switching UI; Web Terminal return is separate, App Back follows Work detail depth and remains within the current Workspace until leaving the surface. No bound Work source means no Work entry. Preserve Contract and revision when switching capabilities.
- **Original static/behavior validation** covered domain revision/Thread/source cases, **before** the capability placement correction. Those earlier results do not prove this revision.
- **Updated smoke:** `node --test work-contract-2541/smoke.test.mjs` should check Workspace Work list → Contract, Files/Git switching, depth/back, no binding, published revisions, Thread, and source errors. Record the actual execution environment and count separately.
- **Actual Chromium desktop/mobile comparison and Pages HTTPS/manifest SHA:** remain unverified until checked. GitHub `prototype` branch source publication is not a Pages deployment receipt; check `https://bestnathan.github.io/nession/prototypes/manifest.json`.
- **Source:** `work-contract-2541/index.html`, `styles.css`, `app.js` and tests in the shared `prototype` branch. Do not claim pixel-perfect matching of React WorkspaceShell or CapabilityCapsule based on this HTML mock.
