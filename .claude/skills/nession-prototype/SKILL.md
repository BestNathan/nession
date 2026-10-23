---
name: nession-prototype
description: Use when planning, creating, iterating, publishing or reviewing interactive Nession product/UI prototypes, including the shared orphan prototype branch, clickable mock flows, Issue links, pinned previews and prototype fidelity/validation.
---

# Nession Prototype

This Skill owns the **design-prototype workflow**: interaction questions, mock fidelity, isolated authoring, shared prototype-branch publication, verification, and Requirement backlink. It **does not** own whether a Requirement needs a prototype (see [nession-writing-requirements](../nession-writing-requirements/SKILL.md)), production UI implementation (see [nession-development](../nession-development/SKILL.md)), Nession design doctrine (see [nession-web-design](../nession-web-design/SKILL.md)), or trusted Acceptance (see [nession-acceptance](../nession-acceptance/SKILL.md)).

A prototype is a way to **test a product interaction and settle uncertain behavior before production implementation**, not a default deliverable for every Issue and not a shortcut around implementation, security, CI or E2E evidence.

## 1. Read product and prototype context

Before authoring:

1. Read root `AGENTS.md`, `VISION.md`, `PRINCIPLE.md`, the affected `docs/design/*` sources and the owning Requirement/Bug.
2. For UI patterns, read [nession-web-design](../nession-web-design/SKILL.md); when changing production Web/design sources, also read their scoped `AGENTS.md`. **Do not edit production Web or canonical design sources as part of a standalone mock prototype.**
3. Inspect `origin/prototype`, its `README.md` / gallery `index.html`, and any relevant existing prototype; discover whether the same interaction is already represented. **Reuse/extend the owning prototype directory** for the same Requirement rather than making duplicates.
4. Read the Issue's `Prototype` decision. If absent, ask the authoring workflow to record the decision before substantial prototype work; do not invent a separate Requirement for the prototype alone when the interaction is already owned.

The repo has two complementary interaction patterns: [#2221](https://github.com/BestNathan/nession/issues/2221) explores System One AI Workspace Scene orchestration and [#2254](https://github.com/BestNathan/nession/issues/2254) explores System Two Text-to-Component AI Conversation. **Use them as examples, not as a universal UI shell or hardcoded design.**

## 2. Define what the prototype needs to prove

Write a small scenario/fidelity contract in the prototype `README.md` **before designing screens**:

- **Question/decision:** what user behavior, state transition, layout/ownership or interaction tradeoff is unresolved? What observation would settle it?
- **Entry and user goal:** how does the user arrive, what do they see before any action, what ends the flow?
- **Representative states:** blank/initial, loading/streaming (if relevant), success, error/unavailable, empty, partial input, return/reopen, and irreversible action confirmation where relevant.
- **Critical paths:** at least one full end-to-end *mock interaction*, not a set of disconnected static screenshots.
- **Devices:** Web and narrow/mobile widths when applicable; keyboard/touch/focus/scroll behavior for interactive controls.
- **Fidelity:** explicitly classify business data, model decisions, state persistence, network calls, and side effects as `mock`, `recorded fixture` or `real read-only evidence`; name all gaps.
- **Non-goals:** what remains for the real Requirement and later production implementation?

Prefer the smallest convincing flow. A handful of connected interactions with observable state is more useful than a large decorative interface. Follow `PRINCIPLE.md`: start from the work, keep the initial surface quiet, let capabilities emerge by context, and use progressive disclosure. Never turn a prototype's incidental navigation/layout into a durable product rule without a separate design decision.

## 3. Shared publication branch and directory

**One shared, history-isolated orphan branch:** `prototype`. Every prototype occupies **one sibling directory**:

`<topic>-<issue-number>/`

Examples: `ai-workspace-2221/`, `ai-conversation-2254/`.

A prototype directory must contain:
- `index.html` — directly accessible, standalone interactive browser entry; all referenced assets use relative paths.
- `README.md` — linked Requirement, goals, scenario, fidelity, usage, checks, limitations.
- Optional `styles.css` / `app.js` or `app.mjs`, mock data, `PROTOCOL.md`, `schema.json`, and dependency-free smoke tests, **only when their behaviors need to be inspectable or tested**.

Update the branch-root `README.md` catalog and `index.html` gallery **without removing or rewriting unrelated prototypes**.

### Isolation and concurrent editing

The normal `main` development/PR workflow is **not** the prototype publishing workflow:

- Keep the root checkout a clean, read-only `main` mirror.
- Create an **isolated worktree from `origin/prototype`**, not from `main`, for prototype assets. Do not create another remote `prototypes/<issue>` branch or merge the orphan branch into `main`/`staging`.
- An optional *local* worktree branch is fine; the single shared remote publication target remains `prototype`.
- Before publishing, fetch the latest shared branch and integrate concurrent additions; never force-push, reset remote history, or overwrite a different Issue's directory.
- Commit prototype assets and gallery updates, then push **fast-forward** to `prototype`. If the shared tip moved, fetch/rebase the local prototype-only work and re-check before pushing.
- Do not place source-of-truth architecture, production protocol, CI workflows, secrets or backend code on the mock branch.

Example from a clean root checkout:

~~~sh
git fetch origin main prototype
git worktree add -b proto-<issue-number> .claude/worktrees/proto-<issue-number> origin/prototype
cd .claude/worktrees/proto-<issue-number>
mkdir -p <topic>-<issue-number>
# Build/mock/verify and update the shared gallery.
git status
git diff --check
git add <topic>-<issue-number>/ README.md index.html
git commit -m "docs(prototype): explore <topic> (#<issue-number>)"
git fetch origin prototype
git rebase origin/prototype
git push origin HEAD:refs/heads/prototype
~~~

If these commands conflict with a modified `prototype` branch's current catalog/structure, **inspect and reconcile**, never overwrite. The ordinary `nession-development` branch/worktree/PR/CI procedure still applies to this Skill's **own documentation or code changes on main**; the above exception is solely for design artifacts on the orphan branch.

## 4. Build the interactive design

1. **Begin with behavior, not arbitrary pages.** Mock real Nession nouns (Agent, Session, Terminal, Git, File, etc.) and scenario-relevant transitions; keep UI consistent with current Vision, Principles and appropriate Nession design-system roles.
2. Make all visible actionable controls **work inside the mock**, update state deterministically, and show a result or an explicit disabled/unavailable explanation. Avoid inert buttons, fake network spinners that never settle, or a form that never submits.
3. Preserve business meaning: a UI-only `Create Session` simulation must require an explicit user submit; merely showing a form or receiving model text cannot create a resource. Closing a Scene, message or component must not imply killing a backend Session.
4. Keep model inference and backend data clearly marked. Simulated intent routing/scoring is a **mock**; do not label it a real AI decision. Do not call paid models or production APIs without explicit user authorization and a separate approved scope.
5. Prefer reproducible local fixtures with reset/replay, sensible error and latency states, keyboard-operable controls, visible focus and readable narrow layouts. Debug/inspector panels can expose parsed text, event/state transitions and action availability if that is what needs evaluation.
6. Use plain HTML/CSS/JS and local assets by default; avoid builds, external CDNs and runtime dependencies unless a specific prototype question requires them. If assets require ES modules, serve via a local HTTP static server and document how. Avoid copying product code into a second implementation disguised as a finished feature.
7. Never ship private Agent addresses, credentials, tokens, personal data, live Session output, environment values, proprietary model logs or unredacted user files in a **public** prototype. Sanitize any recorded fixture.

A product scenario may warrant a visual approximation rather than exact shadcn internals; explicitly distinguish prototype appearance from a proven production component/design-system implementation.

## 5. Verification and evidence

Verify **what the prototype claims**, not unrelated production invariants:

- **Static:** files/relative paths exist, HTML/JS/JSON parse correctly, no missing fixture dependencies, no broken gallery links, no secrets.
- **Deterministic behavior:** run provided smoke tests and negative-path tests (invalid input, unavailable data, duplicate submit, stale state/reference, reset/replay); report exact commands, counts and results.
- **Real browser:** open the published/local page with an actual browser; click through the primary scenario, inspect desktop and narrow viewport, keyboard/focus/scroll, console errors and resource loads. Record screenshots or a concise reproducible browser walkthrough when possible.
- **Fidelity:** separate `mock smoke passed`, `browser interaction verified`, `live API integration verified` and `trusted production Acceptance` in both README and Issue.

**Never report browser verification because files exist, a parser smoke passed, a third-party URL was constructed, or an external preview service usually works.** If no browser is available, explicitly mark it unverified. Browser/design/E2E proof for production changes remains owned by `nession-web-design` and `nession-acceptance`, not this Skill.

## 6. Publish and link to the owning Issue

After the final prototype and gallery commit:

1. Fetch/verify the **exact remote `prototype` HEAD SHA** and the files under the target directory. Pin links to that immutable commit, not just `prototype`.
2. Add a conspicuous **Interactive prototype** subsection in the Requirement description with:
   - clickable preview (where available) and the immutable source/GitHub directory;
   - `PROTOCOL.md` / design notes and smoke commands where applicable;
   - what is mocked vs actually live;
   - tested interactions, test result, browser-validation status and limitations.
3. The existing gallery uses external `raw.githack.com` / `rawcdn.githack.com` for static HTML previews; these are **third-party** renderers, not GitHub Pages for the orphan branch. Only link verified actual URLs; distinguish a constructed URL from one whose delivery was opened in a browser, and note external renderer/cache risks. Always include a GitHub source link as fallback.
4. When revising, publish a new commit and update the Issue's **pinned SHA** and fidelity/evidence notes while keeping decision history. Do not silently move the source under an old pinned link.
5. A prototype can inform or satisfy an explicitly defined **prototype-specific deliverable**, but does **not** prove production Success Criteria, E2E cases, backend/AI integration or security. Preserve trusted Acceptance Report status until the appropriate owner records real evidence.

## 7. Completion and stop conditions

A prototype handoff reports: owning Issue, branch/immutable commit, preview + source, supported scenario, exact checks, observed browser state, fidelity gaps, and next product decision.

Stop or clarify when the prototype lacks an owning Issue, duplicates an existing owner, asks for production mutations/secrets under a mock label, requires overriding the shared orphan branch history, or is presented as a substitute for trusted Acceptance.
