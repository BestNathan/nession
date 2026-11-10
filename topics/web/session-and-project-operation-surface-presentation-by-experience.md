---
title: "Session and Project operation surface presentation by Experience"
description: "The Experience route selects Web's content-capable centered Attach/Session/Project dialogs versus App's quick Attach sheet and full-height operation depths, over one Attach, create-Session and Project-form owner; the Web Existing Location Select is content-sized for multi-line records"
topic: web
categories: ["web", "app", "interaction", "session", "project", "presentation", "responsive"]
status: verified
created_at: 2026-11-09T11:34:00Z
updated_at: 2026-11-10T04:45:00Z
sources: ["https://github.com/BestNathan/nession/issues/3089", "https://github.com/BestNathan/nession/pull/3109", "https://github.com/BestNathan/nession/pull/3126", "https://github.com/BestNathan/nession/blob/8dfb163bb4e998198dd23ca5fde7cde3b06021c9/web/src/components/ui/select.tsx", "https://github.com/BestNathan/nession/blob/8dfb163bb4e998198dd23ca5fde7cde3b06021c9/web/src/product/session/components/CreateSessionDialog.tsx", "https://github.com/BestNathan/nession/blob/8dfb163bb4e998198dd23ca5fde7cde3b06021c9/web/src/app/fixture/fixtureProjects.ts", "https://github.com/BestNathan/nession/blob/8dfb163bb4e998198dd23ca5fde7cde3b06021c9/e2e/tests/browser/project-session-create.spec.ts", "https://github.com/BestNathan/nession/blob/8dfb163bb4e998198dd23ca5fde7cde3b06021c9/e2e/acceptance/cases/3089/SC-07/verify.spec.ts", "https://github.com/BestNathan/nession/blob/8dfb163bb4e998198dd23ca5fde7cde3b06021c9/e2e/acceptance/cases/3089/SC-08/verify.cjs", "https://github.com/BestNathan/nession/blob/f3c0e8dd0f85f93c6dd3174ba6134c3af138c228/session-operation-surfaces-3089/README.md", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/app/experienceMode.ts", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/app/experiences/app/AppOperationPage.tsx", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/app/experiences/app/AppAttachSurface.tsx", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/app/experiences/app/AppCreateSessionSurface.tsx", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/app/experiences/app/AppProjectFormSurface.tsx", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/components/ui/dialog.tsx", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/product/session/hooks/useAttachConfiguration.ts", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/product/session/hooks/useCreateSessionForm.ts", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/product/project/hooks/useProjectDraftForm.ts", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/e2e/tests/browser/app-attach-presentation.spec.ts", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/e2e/acceptance/cases/3089/SC-06/verify.cjs", "https://github.com/BestNathan/nession/blob/8a9b670b4b82d93cec48bad81d24c8d677119659/session-operation-surfaces-3089/index.html"]
---

# Session and Project operation surface presentation by Experience

## Decision

The **Experience** selects the composition of Session and Project operations;
the viewport selects the geometry inside it. `resolveExperienceMode` returns the
explicit `?experience=web|app` route when present, otherwise wide Web and narrow
App. A narrow forced Web stays a responsive Web dialog; a wide forced App keeps
the App navigation hierarchy.

Web renders content-capable centered dialogs:

- Attach targets 720px, Create Session 640px and Project create/settings 720px,
  clamped to the viewport with a sticky header/footer and one scrolling middle.
- Auto/P2P/Relay stay side by side on the wide surface. Candidate addresses
  wrap rather than truncate and each has an explicit Copy-full-address action.
- Create Session shows Agent and directory on distinct lines (trigger and
  options), and Project Existing Locations use a two-row directory field whose
  Agent/Directory row stacks when constrained.

App does not shrink those dialogs into centered cards:

- Default Attach opens a bottom quick sheet over the mounted Terminal: Session
  identity, the resolved connection summary, one primary Attach action and a
  Connection settings entry. The full configuration is a pushed full-height
  page; Back returns to the sheet with the mode/address draft preserved, and
  only the sheet's Attach attaches.
- The explicit Attach-settings intent opens the full configuration directly.
  Its single action saves the preference; it can never attach.
- Create Session, with or without a Project, is a full-height operation page:
  one header/Back, Session name, an Existing Location/Agent row and an ENV
  summary that pushes a selection list, with a safe-area anchored CTA. Child
  depths preserve the draft; an offline Agent or validation error is explicit
  and blocks the CTA.
- Project create/settings are the same full-height depth with stacked
  touch-sized location cards. Small rename/delete confirmations keep the shared
  dialogs.

One owner per operation is preserved: `useAttachConfiguration` owns Attach
selection, probing and choice building; `useCreateSessionForm` owns Session
validation/creation (its action is exposed without a form-event dependency);
`useProjectDraftForm` owns Project payload validation/persistence. Web and App
render those owners through different compositions, and the shared Dialog
primitive exposes `centered`, `fullscreen` and `sheet` arrangements rather than
a second overlay implementation. No protocol, Server, Project-domain or attach
transport behavior changed.

## Content-sized Select boundary

Project → New Session names an Existing Location as Agent + directory + status.
The generic Select primitive originally fixed every trigger at 32px and kept
option text on one line (`shrink-0 whitespace-nowrap`) while the popup used the
anchor width and hid horizontal overflow, so a three-line selected record could
overflow the control and a long directory clipped in the menu.

The primitive now exposes two opt-in variants: `SelectTrigger size="content"`
(no fixed height, wrapping, no line clamp) and `SelectItem multiline` (wrapping
option text with a shrinkable flex child). Single-line Selects keep the original
contract. The Project location uses both; the popup stays at the anchor width
and overlays the form, and the dialog remains the only vertical scroll owner.
The fixture's `?projects=long` scenario supplies two online multi-segment
locations for the geometry proof; normal, offline and no-location states stay
separately covered.

## Context and evidence

Issue [#3089](https://github.com/BestNathan/nession/issues/3089) owns the
cross-Experience presentation decision; the prior Project domain and maintenance
work remain owned by #3021/#3025 and Session membership by #3082. The reviewed
interactive prototype is pinned at
`8a9b670b4b82d93cec48bad81d24c8d677119659` under
`session-operation-surfaces-3089/` on the orphan `prototype` branch and is
published through the public Pages manifest/gallery.

The delivered PR is [#3109](https://github.com/BestNathan/nession/pull/3109),
merged to staging at `2811fb1967e0f3f4f625c38b9c70933bf1f778e7`. Pre-merge Case
Smoke run `42606207082` passed SC-01…SC-06 at the PR head; the selected E2E run
`42606207261` passed the new `app-attach-presentation` (2/2) and
`app-session-operations` (1/1) specs plus the `project-management`,
`project-sidebar-detail` and `session-lifecycle` regressions. SC-06 is proven by
a runtime readback of the pinned source, the public Pages manifest entry and the
live gallery, not by a production Chromium result for the mock.

The post-acceptance Select correction is PR
[#3126](https://github.com/BestNathan/nession/pull/3126), merged to staging at
`8dfb163bb4e998198dd23ca5fde7cde3b06021c9`. Pre-merge Case Smoke run
`42648295776` passed all eight criteria at the PR head: SC-07 (213 assertions)
measured the content-sized trigger and wrapped options at 1440/1180/1024 and
390 narrow forced Web with pointer/keyboard selection and one scroll owner;
SC-08 (94 assertions) verified the revised prototype `f3c0e8dd` is published
unchanged by the live Pages manifest (`8c6e943d`) and performed its Chromium
click-through. Selected E2E run `42648295781` passed `project-session-create`
(7/7) plus the declared regressions.

## Limits and when to revisit

- Dialog widths (720/640) are initial design targets, not constants; a change to
  a token or a gate must keep the responsive clamp and the single scroll owner.
- App operation pages are full-viewport Dialog arrangements over the mounted
  shell, not new entries in the App's spatial layer stack. The selected Session
  and Terminal stay mounted underneath; a future App navigation model must
  preserve that context before replacing the arrangement.
- The Attach quick sheet confirms the currently resolved mode (Auto by default).
  Choosing P2P, Relay or a manual address requires the configuration depth.
- The prototype is a deterministic mock. SC-06 verifies its public, versioned
  preview and its no-network source; it does not establish a Chromium
  interactive Acceptance result for the production surfaces.
- The content-sized Select is a variant, not a global restyle: single-line
  triggers keep their 32px height and one-line value. Revisit if another
  multi-line Select consumer appears; it should opt in rather than widen the
  default contract.
- Keyboard, safe-area and visual-viewport behavior are asserted through
  Chromium and app-owned fixture inputs. Native iOS/Safari behavior is not
  claimed.

Related knowledge:

- [Web Session-first navigation, reserved rail and explicit experience mode](web-session-first-navigation-reserved-rail-and-explicit-experience-mode.md)
  owns the Experience selection and the Web navigation shell this contract
  composes into.
- [Project declaration and Workspace location ownership](../engineering/project-declaration-and-workspace-location-ownership.md)
  owns the Project domain, Existing Locations and the Project-aware create path.
- [Session metadata and display identity ownership](../engineering/session-metadata-and-display-identity-ownership.md)
  owns Session identity and the tmux instance fence that the attach and create
  surfaces present.
- [Unified overlay and operation surface system](unified-overlay-and-operation-surface-system.md)
  owns the cross-family overlay roles, size tokens, scroll/stacking/dismissal
  contract that these compositions select from.
