---
title: "Session and Project operation surface presentation by Experience"
description: "The Experience route selects Web's content-capable centered Attach/Session/Project dialogs versus App's quick Attach sheet and full-height operation depths, over one Attach, create-Session and Project-form owner"
topic: web
categories: ["web", "app", "interaction", "session", "project", "presentation", "responsive"]
status: verified
created_at: 2026-11-09T11:34:00Z
updated_at: 2026-11-09T11:34:00Z
sources: ["https://github.com/BestNathan/nession/issues/3089", "https://github.com/BestNathan/nession/pull/3109", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/app/experienceMode.ts", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/app/experiences/app/AppOperationPage.tsx", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/app/experiences/app/AppAttachSurface.tsx", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/app/experiences/app/AppCreateSessionSurface.tsx", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/app/experiences/app/AppProjectFormSurface.tsx", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/components/ui/dialog.tsx", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/product/session/hooks/useAttachConfiguration.ts", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/product/session/hooks/useCreateSessionForm.ts", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/web/src/product/project/hooks/useProjectDraftForm.ts", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/e2e/tests/browser/app-attach-presentation.spec.ts", "https://github.com/BestNathan/nession/blob/2811fb1967e0f3f4f625c38b9c70933bf1f778e7/e2e/acceptance/cases/3089/SC-06/verify.cjs", "https://github.com/BestNathan/nession/blob/8a9b670b4b82d93cec48bad81d24c8d677119659/session-operation-surfaces-3089/index.html"]
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
- Keyboard, safe-area and visual-viewport behavior are asserted through
  Chromium and app-owned fixture inputs. Native iOS/Safari behavior is not
  claimed.

Related knowledge:

- [Web Session-first navigation, full tuck-away and explicit experience mode](web-session-first-navigation-full-tuck-away-and-explicit-experience-mode.md)
  owns the Experience selection and the Web navigation shell this contract
  composes into.
- [Project declaration and Workspace location ownership](../engineering/project-declaration-and-workspace-location-ownership.md)
  owns the Project domain, Existing Locations and the Project-aware create path.
- [Session metadata and display identity ownership](../engineering/session-metadata-and-display-identity-ownership.md)
  owns Session identity and the tmux instance fence that the attach and create
  surfaces present.
