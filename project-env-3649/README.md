# Project default ENV → Session creation (Requirement #3649)

- **Issue:** https://github.com/BestNathan/nession/issues/3649
- **Prototype:** `project-env-3649/index.html` (standalone interactive HTML, local CSS/JS + sibling shared `prototype-frame-2758` frame)
- **Canonical preview target:** https://bestnathan.github.io/nession/prototypes/project-env-3649/index.html (**unverified until Pages source SHA and HTTPS readback match**)
- **Baseline main (source reviewed):** `d6f6e70958336f8f4b80433be510bf54a1f55c08` (2026-11-15); sources: `docs/design/project.md`, `docs/design/product-model.md`, `design/generated/web.css`, `web/src/product/project/{model/projectDraft.ts,hooks/useProjectDraftForm.ts,components/ProjectDetail.tsx,components/ProjectFormFields.tsx}`, `web/src/product/session/hooks/useCreateSessionForm.ts`, `web/src/product/session/components/CreateSessionDialog.tsx`, `crates/nession-server/src/server/handler/server_session_create_v1.rs`.
- **Related designs:** [#3025 Project-to-Session flow](../project-session-3025/index.html), [#3089 experience-aware operation surfaces](../session-operation-surfaces-3089/index.html), [#2654 Session ENV workspace](../environment-session-2654/index.html). This is a new distinct interaction decision for #3649; it does **not** replace those owners.

## Product question / ownership

Can users configure Project defaults and then understand (before Submit) which ENV files will bind to a new Session, including an explicit **No environment** choice, without implying that Project owns or continuously syncs Session Environment Binding?

- Global Server ENV Library owns ENV contents; Project owns ordered **references** only.
- Project Session defaults are create-time suggestions. At creation the **Server** resolves profiles, Agent snapshots and Session-owned durable binding; later Project edits never mutate existing Sessions.
- Existing `env_files: []` is ambiguous (legacy Server semantics = inherit Project defaults). Candidate optional `env_selection_mode: 'inherit' | 'replace'` maps the UI's inherit / custom / none to an unambiguous wire contract. Empty replace means deliberate no ENV. This remains **unimplemented in production**.
- Default selection in the iteration is restricted to **Server ENV** files; using Agent ENV as Project defaults is not implied.

## Mock journey

1. From the Web Sidebar's Projects list or App Sessions → Projects, open Nession Project Detail. Project Detail is independent of any selected Session.
2. Select **Settings** → Default Environment. Add/remove/reorder the Server ENV references; Save. Observe Project Detail list in the same order.
3. Select **Create Session**. Default is **Use Project defaults**, with visible effective list. Switch to **Custom** for explicit replacement or **No environment** for an explicit empty replacement; compare preview and submit a named Session.
4. Observe the new Session's isolated Binding list, revision and source. Return to Project, edit defaults, then open the original Session: its list is unchanged. Create another Session to see updated defaults.
5. Use the outer reviewer fixtures to simulate a missing `development.env`, then try to inherit it and Create; expect a visible failure, not silent fallback. Use **Set Project defaults to empty** to exercise an empty Project.
6. Switch Web 1180 → App 390/375 → Web 1024/1180 without reloading. App shows Session/Project depth with exactly one top-level page header and Back action; operation screens are full-depth, not Web-like centered dialogs. Browser size controls/fixtures stay **outside** the product preview.

## Current-product IA → mock correspondence

| State | Source ownership and current layout | Mock projection / candidate |
|---|---|---|
| Web Project Detail | `WebLayout → Sidebar (flat Sessions + Projects) + ShellMain → independent ProjectDetail` | Web sidebar remains a sibling; Project Detail has sections/quick actions; settings/create are centered Web operations |
| App Project Detail | `AppLayout/AppLayers → Sessions → Projects → pushed ProjectDetail` | App single page header/Back; Project remains accessible without a selected Session |
| Web/App Project Settings | `ProjectDialogs / ProjectFormFields`, ConfigurationForm/OperationSurface (#3137/#3089) | Adds a candidate Default Environment list within existing settings; add/remove/reorder and save |
| Create Session | `CreateSessionDialog / useCreateSessionForm`; Web modal / App operation depth (#3089) | Adds three explicit modes and an effective-preview summary; submit only on explicit Create |
| Session | Session primary work, membership #3082, ENV ownership #170 | Displays simulated independent Binding snapshot and navigation; **not a production ENV Workspace replica** |

**Candidate delta:** only Project Default ENV editable control and Session create-time mode/effective preview. No additional Workspace shell, ProjectEnvironment dashboard, Agent selector, new top-level app header, global Shell banner or permanent ENV controls.

## Data fidelity and negative states

All `example` names, Agents, Project default lists, Session IDs, revisions, save actions and errors are mock-only memory fixtures; no HTTP/WS, real tmux, real file content, real secret, real ENV variable name/value or production Session side effect. No external dependencies except sibling static presentation assets. A missing file fixture rejects mock creation; no backend security assertion is claimed. `Reset` reloads deterministic initial state.

Unsupported behaviors intentionally remain outside prototype: full Project CRUD, actual Agent-scoped Project defaults, secret-value display, real desired/observed convergence, concurrent Binding CAS, Project delete semantics and production authorization.

## Verification record

- **Static JS syntax:** PASS, checked the actual GitHub `prototype/project-env-3649/app.js` contents using JavaScript compiler parser (`new Function(source)`) after upload. No business code was executed by this check.
- **Source/relative assets:** page refers to `styles.css`, `app.js`, `../prototype-frame-2758/frame.css` and `frame.js`; shared frame exists on the `prototype` branch. Root gallery and README links are maintained separately.
- **Interactive real Chromium/Playwright:** **UNVERIFIED** until a browser runner executes actual actions and measures rendered widths, horizontal stage edge access, one App header, dirty drafts, empty and missing profile flows, session retention and console/network errors.
- **Pixels and App runtime:** source-informed approximation only; no production React side-by-side screenshot/geometry/physical iOS proof.
- **Trusted Pages publication:** **UNVERIFIED** until `https://bestnathan.github.io/nession/prototypes/manifest.json` and preview HTML read back the exact final prototype branch SHA. Published source is versioned independently of new `prototype` pushes.
- **Production Acceptance/E2E:** all remain Pending in #3649; this mock is **not** an acceptance receipt.

## Smoke walkthrough (manual, untrusted until executed)

Serve the branch root statically (`python3 -m http.server 8080`) and visit `http://localhost:8080/project-env-3649/index.html`. Run: set Project defaults → save → create inherited Session → open original → change Project defaults → original unchanged → create explicit-empty Session → verify no ENV → missing-file failure → Reset → Web/App mode round trip and Back. Inspect console for errors. No project checkout or real ENV needed.
