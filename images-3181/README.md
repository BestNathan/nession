# Prototype · Server-owned Images (#3181)

Linked Requirement: [#3181](https://github.com/BestNathan/nession/issues/3181) — Server-owned Images capability discoverable in Workspace and consumable by Project/Sandbox/Agent.

Status: **Draft prototype for product sign-off**, not production UI and not Acceptance evidence.

## Product surface and fidelity baseline

- Surface: full Web product shell at 1180/1024 CSS px and App shell at 390/375 CSS px.
- Web ownership tree represented:
  `WebLayout → Sidebar (Agents + Sessions) + main → Workspace content → Images capability`.
  No Session is selected, so the capability is discovered from Server-owned resources rather than from a Session or Agent.
- App ownership tree represented:
  `AppLayout → Workspace capability entry → Image list → Image detail / Picker / Build`, with one App page header owning Back and title at each depth.
- Reference sources: `web/src/product/workspace`, the Terminal/Workspace capsule and page-header patterns, and generated `--nession-*` token semantics. The mock is a standalone HTML approximation, not a rendering of those components.
- Current-vs-candidate delta: this prototype explores **whether** Images should be a contextual Workspace capability plus a shared Picker for Project and Sandbox. It does not propose a new permanent global navigation item.

Known fidelity limitations:

- The sidebar and App shell are simplified fixtures; no real Session/Terminal runtime is present.
- The App capability entry is a single card, not the full Workspace capability catalog.
- Motion, focus trapping, virtualized rows, real pagination semantics, auth scoping and error codes are approximated or omitted.
- Status copy is illustrative; it is not copied from an accepted server contract.

## Decision the prototype should settle

1. Does Images appear as a Workspace capability when no Session exists, without becoming a global sidebar entry?
2. Should Project image selection and Sandbox image composition share one Picker and one reference model?
3. Is the distinction between Server Ready and Agent cache readiness legible enough to prevent a user from assuming mountability?
4. Does an explicit bind after a Git build (and preserving the old reference on failure) match product expectations?
5. Does pinning an Alias to a resolved Digest at selection time make Alias movement safe and understandable?
6. Does the App navigation keep a single Back/title owner across list → detail → picker/build?

## Entry and goal

- Workspace: the user has no Session selected, opens the Workspace, sees a Server resources capability entry, opens Images, searches/pages the inventory and inspects an image.
- Project: the user has a Git Source, chooses a Registry image or builds one, and only then explicitly updates the Project reference.
- Sandbox: the user adds images through the same Picker, sets independent target paths and read-only/overlay composition, and observes a pinned Digest.

## Scenarios

| Scenario | What it shows |
|---|---|
| `normal` | 235 images, mixed Server/Agent states, complete paging (50 per page), search. |
| `empty` | Server reports Images but the inventory is empty; no fake rows. |
| `unavailable` | Server does not report Images; Workspace capability is disabled with a reason and no cached Agent image is presented as available. |
| `buildfail` | Git build fails; the previous Project reference is unchanged. |
| `agentfail` | Server image is Ready but the Agent cache is Failed; the composition flags “not mount-ready”. |
| `aliasshift` | An Alias now resolves to another Digest; an existing Sandbox/Session pin keeps the old Digest. |

## Critical paths exercised

1. Workspace entry → Images list → search → page → detail (server vs agent readiness).
2. Project → Choose image (shared Picker) → explicit Select updates the reference.
3. Project → Build from Git Source → success → Use this image; or failure → old reference preserved.
4. Sandbox → Add image (same Picker) → edit target/mode → alias movement keeps the pinned Digest.
5. Web ↔ App widths; App list → detail → Back → list → Back → capability entry; Picker/build push and Back.
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
| Static asset/link/selector smoke test | **PASS** — `node smoke-test.mjs`, 30/30 checks on 2026-11-11 |
| Chromium interaction at Web 1180/1024 | **PASS** — 23-check Playwright walkthrough: exact widths, paging/search, detail, shared Picker, explicit build bind, build failure preserving reference, Sandbox target/mode and pin, alias movement, Agent cache failure, Reset, gallery entry, no console errors |
| Chromium interaction at App 390/375 | **PASS** — capability entry → list → detail → Back, one App header, Picker push/back, no horizontal product overflow |
| Narrow-browser stage edges | **PASS** — 720px browser with the 1180px device: both stage edges reachable through horizontal scroll |
| Published Pages preview SHA match | Pending publication; verify `prototypes/manifest.json` SHA after the fast-forward push |
| Production Acceptance | not claimed; belongs to the future implementation |

The browser walkthrough used Chromium and Playwright against the local static file. It verifies this mock's behavior and geometry only. It is not a production component comparison, live API test, visual-regression baseline, or trusted Acceptance result.

## Non-goals

This prototype does not implement Registry APIs, auth policy, Git build execution, image distribution, Agent cache management, Sandbox execution, or production acceptance criteria. Those remain in the Requirement's implementation scope and its Acceptance Cases.
