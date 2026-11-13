# Prototype · Server-owned Images (#3181)

> **HISTORICAL / NAVIGATION SUPERSEDED (2026-11-13):** The old independent Session-less Images Workspace entry depicted below is **not** the current Sandbox+Images product decision. [#3408](https://github.com/BestNathan/nession/issues/3408) moves Images **management presentation** under the selected Session's Sandbox → Images, while the Server still owns the same global registry, build, bytes and grants. [#3407](https://github.com/BestNathan/nession/issues/3407) defines Agent Workspaces; [#3405](https://github.com/BestNathan/nession/issues/3405) owns Filesystem use of EROFS. The revised interactive mock is [sandbox-capability-3124/index.html](../sandbox-capability-3124/index.html) on the same shared branch. The older Chromium receipts and product states below pertain **only to this historical design**; do not claim them for the revised layout.



Linked Requirement: [#3181](https://github.com/BestNathan/nession/issues/3181) — Server-owned Images capability discoverable in Workspace and consumable by Project/Sandbox/Agent.

Status: **Draft revision for product sign-off**, not production UI and not Acceptance evidence.

Revision 2026-11-11: product feedback confirmed that Images must not add a permanent global sidebar item and that **Project and Sandbox are independent**. They no longer share a Picker or reference model; each owns its own selection/composition flow. The delegated target/mode, Digest-pinning and App-depth decisions are recorded below.

## Product surface and fidelity baseline

- Surface: full Web product shell at 1180/1024 CSS px and App shell at 390/375 CSS px.
- Web ownership tree represented:
  `WebLayout → Sidebar (Agents + Sessions) + main → Workspace content → Images capability`.
  No Session is selected, so the capability is discovered from Server-owned resources rather than from a Session or Agent.
- App ownership tree represented:
  `AppLayout → Workspace capability entry → Image list → Image detail / Project image selection / Sandbox add-image / Build`, with one App page header owning Back and title at each depth.
- Reference sources: `web/src/product/workspace`, the Terminal/Workspace capsule and page-header patterns, and generated `--nession-*` token semantics. The mock is a standalone HTML approximation, not a rendering of those components.
- Current-vs-candidate delta: this prototype proposes Images as a **contextual Workspace capability**, with **independent Project and Sandbox flows**. It does not propose a new permanent global navigation item and does not share a Picker/reference model between Project and Sandbox.

Known fidelity limitations:

- The sidebar and App shell are simplified fixtures; no real Session/Terminal runtime is present.
- The App capability entry is a single card, not the full Workspace capability catalog.
- Motion, focus trapping, virtualized rows, real pagination semantics, auth scoping and error codes are approximated or omitted.
- Status copy is illustrative; it is not copied from an accepted server contract.

## Product decisions

**Confirmed by product feedback (2026-11-11):**

1. Images is a contextual Workspace capability; **no permanent global sidebar item**.
2. Project and Sandbox are **independent**; they do **not** share a Picker, selection contract, or reference model. Both consume the Server registry, but through separate flows.

**Delegated decisions recorded by this prototype:**

3. Sandbox owns target path and read-only/overlay per image. A selection pins the resolved Digest immediately; Alias movement does not mutate an existing Sandbox/Session pin. Server Blob readiness and Agent cache readiness stay visibly separate, and a non-verified Agent cache is not mount-ready.
4. App uses a Workspace capability entry and one `AppPageHeader` Back/title owner per pushed depth. Project selection and Sandbox composition each push their own depth; no leaf-level second Back. The Web Project chooser is a single-image reference dialog; the Web Sandbox flow is a wider composition dialog with target/mode. On App, both become full content depths, and the Sandbox form precedes its registry list.

Remaining product sign-off is on the revised independent flows and these recorded decisions, before production implementation.

## Entry and goal

- Workspace: the user has no Session selected, opens the Workspace, sees a Server resources capability entry, opens Images, searches/pages the inventory and inspects an image.
- Project: the user has a Git Source, uses the Project-specific single-image selector or builds one, and only then explicitly updates the Project reference.
- Sandbox: the user opens the Sandbox-specific add-image flow, chooses an image, configures its target and read-only/overlay mode, and adds it with a pinned Digest. This flow does not read or change the Project reference.

## Scenarios

| Scenario | What it shows |
|---|---|
| `normal` | 235 images, mixed Server/Agent states, complete paging (50 per page), search. |
| `empty` | Server reports Images but the inventory is empty; no fake rows in Workspace, Project selection, or Sandbox composition. |
| `unavailable` | Server does not report Images; Workspace capability and both new-image flows are disabled with a reason, while existing references/pins stay visible and unchanged. |
| `buildfail` | Git build fails; the previous Project reference is unchanged. |
| `agentfail` | Server image is Ready but the Agent cache is Failed; the Sandbox composition flags “not mount-ready”. |
| `aliasshift` | An Alias now resolves to another Digest; an existing Sandbox/Session pin keeps the old Digest. |

## Critical paths exercised

1. Workspace entry → Images list → search → page → detail (server vs agent readiness).
2. Project → Select Project image (its own single-image flow) → explicit Use image updates the reference.
3. Project → Build from Git Source → success → Use this image; or failure → old reference preserved.
4. Sandbox → Add image (its own composition flow) → choose image → set target/mode → Add to composition; Project reference stays unchanged.
5. Web ↔ App widths; App list → detail → Back → list → Back → capability entry; Project selector and Sandbox add are separate pushed depths with one header/Back owner.
6. `Reset` reloads the frame and returns to the initial fixture.

## Fidelity classification

- Business data: **mock** (synthetic 235-image inventory, deterministic digest strings).
- Selection/build/alias movement: **mock state only**; nothing is persisted and no network request is made.
- Server/Agent readiness: **mock**; no real Agent cache or Registry access.
- Screenshots/geometry: browser-verified locally against this static page; not compared pixel-for-pixel with production components.
- Production API, authorization, digest verification, blob transfer, build execution and Sandbox mounting: **not implemented** and out of scope for this artifact.

## How to use

Open `index.html` directly in a browser. The prototype frame provides size, context and scenario controls outside the product viewport; these are review controls, not product UI.

Static check:

```sh
node smoke-test.mjs
```

Real-browser check (Chromium via Playwright, from a checkout that has Playwright installed):

```sh
npx playwright open index.html
```

Click through the critical paths at 1180 and 390 widths; verify the App header remains the only Back/title owner and that no console errors occur.

## Verification status

| Check | Status |
|---|---|
| Static asset/link/selector smoke test | **PASS** — `node smoke-test.mjs`, 33/33 checks on 2026-11-11 |
| Chromium interaction at Web 1180/1024 | **PASS** — 24-check Playwright walkthrough: exact widths, paging/search, detail, independent Project selector, explicit build bind, build failure preserving reference, independent Sandbox composition with target/mode and Project isolation, alias movement, Agent cache failure, Reset, gallery entry, no console errors |
| Chromium interaction at App 390/375 | **PASS** — capability entry → list → detail → Back, one App header, independent Project-selector and Sandbox-add depths with Back, no horizontal product overflow |
| Narrow-browser stage edges | **PASS** — 720px browser with the 1180px device: both stage edges reachable through horizontal scroll |
| Published Pages preview SHA match | Pending publication; verify `prototypes/manifest.json` SHA after the fast-forward push |
| Production Acceptance | not claimed; belongs to the future implementation |

The browser walkthrough used Chromium and Playwright against the local static file. It verifies this mock's behavior and geometry only. It is not a production component comparison, live API test, visual-regression baseline, or trusted Acceptance result.

## Non-goals

This prototype does not implement Registry APIs, auth policy, Git build execution, image distribution, Agent cache management, Sandbox execution, or production acceptance criteria. Those remain in the Requirement's implementation scope and its Acceptance Cases.
