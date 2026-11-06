# WorkContract interaction prototype — #2541

## Scenario contract

- **Requirement:** https://github.com/BestNathan/nession/issues/2541
- **Product surface:** contextual work detail surfaced from an AI Workspace/active work entry, not a new global Work navigation, mandatory Session tab, or replacement for Git Workspace.
- **Product baseline:** main `VISION.md`, `PRINCIPLE.md`, `docs/design/product-model.md`, `docs/design/visual-language.md`, `docs/design/interaction/web.md`, `docs/design/workspace.md`, `web/src/app/workspace/WorkspaceShell.tsx`, `design/generated/web.css` semantic variables. Presentation uses shared `../prototype-frame-2758/frame.css` and `frame.js`. Native product rendering is approximated by plain HTML/CSS.
- **Decision:** WorkContract is the **single** work-domain noun replacing WorkItem. Published revisions are immutable definitions; criteria belong to a revision; Thread/Execution/Verification are associated mutable records. GitHub Issue/Feishu/DingTalk are source adapters, not Contract identities.
- **Design question:** Can users distinguish a pinned, published Contract from a changed external source and from a proposed next revision? Can they inspect criteria status without mistaking a checkbox for trusted Acceptance, and see Thread/activity without conflating it with the Contract body?

## Entry → full flow

1. From the current AI/work context, open an existing WorkContract: **Terminal reconnect content mismatch** (sanitized invented example). The entry is contextual, not permanent global navigation.
2. Read v1 published definition and its goal/constraints. Open **Criteria**; each SC shows its immutable wording and separate author checkbox vs trusted verification outcome.
3. Open **Thread** and add a mock comment. The comment is appended to activity, but the published definition/revision stays exactly the same.
4. Review **Source** to see an authorized GitHub Issue binding (real URL pattern but invented content). Switch external fixture to **Source changed**: a pending candidate v2 appears; review its proposed criterion difference. Explicitly choose **Compare revisions** or **Review proposal** and then **Adopt v2 (mock)** via confirmation. The button does **not** write GitHub, publish knowledge or dispatch Agents.
5. Navigate back to v1 in **Revision history** to confirm old definition remains available. Any execution/evidence shown remains pinned to v1; v2 has no magically inherited Pass.
6. Switch fixtures to **Access denied**, **Source unavailable**, **Feishu fixture**. Verify explanations, read-only fallback, and no silent migration or privileged behavior.
7. Change preview from Web 1180/1024 to App 430/390/375. In App the detail is one column with locally scoped navigation; external review controls stay outside product.
8. **Reset** replays the initial state.

## Surface / responsive

- Web work detail: restrained breadcrumb and work title, one main content column with contextual side facts. No full new app shell or a second Git Workspace.
- App work detail: one-page stack with back control and horizontal section nav, depth-aware disclosure, independent scroll in the product viewport.
- Shared review frame sets real CSS pixel widths without zoom/scale; product listens to bubbling `np:resize` and toggles mobile composition at <= 600px.
- Accessible buttons, logical headings, visible focus, scrollable panels and feedback are part of the interactive fixture.

## Fidelity and non-goals

- **Mock only:** contract revisions, criteria, comments, external source, digest, adoption flow, permissions, source errors, account, API and Agent execution are deterministic in-memory fixtures. There is no actual network request, authentication, persistence or live Agent/Acceptance/GitHub/Feishu call.
- **Source binding identity:** `github:github.com:example/nession:issue:42` is a fabricated demo identity showing namespacing; `wc_demo_terminal` is a separate Contract identity, not a production allocation algorithm.
- **Verification authority:** a tick is author-authored text. The prototype never invents a trusted Pass from checkbox or a new contract revision from comments.
- **Candidate vs published:** review/adopt is simulated to explore workflow. Real write/approval permissions and a canonical Contract store are deferred domain decisions, not implemented by this prototype.
- **Visual fidelity:** local snapshot of Nession's neutrals and semantic roles rather than exact shadcn/React, live Workspace composition or active Sessions. Neither pixel-perfect matching nor working production route claimed. Compare against current production fixture in Chromium before accepting a UI implementation.
- **Non-goals:** create/edit external GitHub Issue, real Feishu/DingTalk APIs, Agent dispatch, trusted Acceptance result, new persistent global Work nav, document AST editing.

## Test and publication status

- Smoke procedure: open `index.html` via HTTP/static server and click Overview → Criteria → Thread reply → Source changed → candidate diff → adopt → Revision v1 → denied/unavailable → reset. Validate keyboard focus, scroll and Web/App sizes. All buttons have deterministic local effects; no external dependencies beyond the shared sibling review frame.
- Static, actual browser, and Pages exact-SHA checks must be recorded independently. Merely pushing this branch is **not** evidence of the public HTML being live. Pages manifest: `https://bestnathan.github.io/nession/prototypes/manifest.json`.
- Public preview *after verification*: https://bestnathan.github.io/nession/prototypes/work-contract-2541/index.html
- Pin exact source SHA in the Issue once published; the publisher supplies an immutable `View source` link on the served page.

## Verification record (2026-11-06)

- **Static connector-backed source check:** 8/8 frame/asset/size/gallery/README/semantic-fixture assertions passed; the fixture uses exactly one shared frame, one product viewport and no CSS scale/zoom.
- **V8 JavaScript parse check:** `app.js` compiled with V8 `Function` syntax parser successfully.
- **Deterministic in-memory interaction harness:** 16/16 cases passed: published v1, checked vs trusted Pending, Thread append, source change, candidate comparison open/close, confirmation, explicit v2 adoption, v1 history and v1 execution pin, denied/offline/Feishu, 390/1180 responsive mode and contextual back/reopen. The harness simulates DOM events; it is **not** Chromium/browser proof.
- **Repeatable local smoke test:** `node --test work-contract-2541/smoke.test.mjs` (added but **not executed** in Node in this review environment). Test file covers seven end-to-end scenarios with an isolated fake DOM.
- **Real Chromium Web/App screenshot and interactive browser click-through:** NOT VERIFIED. Product Web/App source comparison is source-reviewed only; do not claim pixel/behavior parity.
- **Public Pages HTTPS and exact manifest SHA:** NOT VERIFIED at authoring time. GitHub source branch is published; public preview may lag and must be checked against the exact prototype commit, not assumed live.
