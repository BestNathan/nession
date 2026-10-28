# Git capability · GitHub repository context — interactive prototype (#1290)

[Owning Requirement #1290](https://github.com/BestNathan/nession/issues/1290) · [Standalone HTML](index.html) · [Native Pages prototype library](https://bestnathan.github.io/nession/#/prototypes)

## Question and design decision

**Question:** how can the current Git capability expose the local repository and its GitHub Issues / PRs / Actions context without inventing a second global capability, a seven-tab bar, or the **superseded Git Peek** step?

**Decision being tested:** select **Git from the Capsule and open Git Workspace directly**. Within Git Workspace, choose a primary context (**Repository** or **GitHub**) and a scoped secondary view. No Git-specific intermediate Peek, extra floating window, GitHub capability icon or GitHub write controls.

This is a UI-design proposal for #1290, **not a change to the global Capsule contract**. Historical main docs and code may still implement Peek for Git or other features; that production change and reconciliation remain unimplemented.

## Full mock walkthrough

1. Open [index.html](index.html) directly in a browser; initial view is the current Session Terminal and its quiet Conversation Capsule.
2. Press **+** to open the context list, then choose **Git**: it must **open Git Workspace immediately**, not a Peek. The alternative Workspace destination circle also opens Workspace; choose the Git item in the bottom Capability Capsule.
3. See local **Repository → Changes**, select another changed file to inspect read-only diff; try **History**, **Branches** and **Worktrees**.
4. Change to **GitHub → Issues**; filter open/closed/all, search by title/description, select **real #1290**. The desktop view uses a bounded, independently scrolling **list on the left** and a full-height **Markdown-reading article on the right**, preserving selected row/filter. Click #2514 and #2323 to compare long-form hierarchy, headings, checklists and code blocks.
5. Change to **Pull Requests**; inspect **actual open #2229/#2222** and merged #2518/#2522 (select Closed or All). Real title, state, author, head/base branches, change counts, and verbatim captured PR description appear in the reader. The synthetic Session branch `feature/git-context` has **no matching real open PR**, so association truthfully reports none instead of inventing a match.
6. **Layout behavior:** on desktop, toggle **Focus reading** to collapse the list and devote width to a long issue body; toggle Show list to return. On mobile/narrow widths, the list is initially visible, tapping a row **pushes into a dedicated detail reading view**, and **Back to list** (or Escape) returns without dropping filter/search/selection. These are Git capability-internal states and do not create another Capsule/Peek.
7. Switch the discovered **Remote** from **upstream / BestNathan/nession** to **origin / demo-fork/nession**: the fork is mock-only and deliberately shows **No snapshot captured** rather than displaying upstream's records under a false repository identity.
8. Open **Actions**; toggle **Current branch** vs **Repository** latest-run scope. These workflow runs are **synthetic mock data**. An unrelated green main run is not allowed to imply current-branch success. Observe disabled and no-runs states.
9. In the bottom **Prototype controls**, use **Scenario** to try Multiple remotes (choose one of the Agent-discovered choices), No GitHub remote, Authentication required, Access denied, Rate limited, Network unavailable, Empty repository and Never executed. GitHub's failure must not block **Repository**.
10. Press **Refresh** for an explicit simulated snapshot counter; inspect state/event log; return to the same Terminal via the Capsule circle, or press Escape. **Reset** returns to initial Terminal.


## Interaction and responsive contract

- **Entry:** one Git capability; Terminal context disclosure -> direct Git Workspace; Workspace Capability Capsule -> direct Git Workspace. No Git Peek and no independent GitHub capsule entry.
- **Layout:** primary Repository vs GitHub hierarchy with secondary scoped tabs. **Desktop:** stable ~36% left list + flexible right reader, independently scrollable with bounded height and selected-item styling; optional full-width Focus reading. **Mobile:** list-to-detail push, Back to list without losing selection/filter, no squeezed 2-column list. Detail body has readable headings, lists, code blocks, links and trailing Capsule scroll clearance. Actual GitHub Markdown is rendered by a deliberately limited, HTML-escaped mock formatter (not production GitHub-flavored Markdown).
- **Visibility:** only the chosen category is rendered. The mock does not make background API requests or invoke interval polling.
- **Errors:** no remote, ambiguous remote, auth, denied, rate limit, offline are distinct. All leave local Git accessible. Empty/no-runs are **valid empty outcomes**, not failures.
- **Focus/return:** active Session identity persists when moving Terminal ↔ Workspace; route into the Git Workspace is direct with no intermediate view. GitHub record select/back and focus-reading preserve the category/filter; Escape returns mobile detail to list before leaving Workspace. Keyboard Tab/focus-visible support the demo. This is a **mock approximation**, not verified React/Capsule focus management.
- **Safety:** no GitHub write actions, no real OAuth/secret fields, no production origin/Agent endpoints, no arbitrary host selector or external API calls.

## Fixture and fidelity

| Concern | Fidelity |
|---|---|
| Agent, Session, branch, local files, Actions and fork identity | Public-safe **synthetic fixtures** |
| GitHub Issue and PR metadata, URLs and descriptive Markdown | **Real public BestNathan/nession records captured 2026-10-28**, embedded in `fixtures.js`, never live-refreshed |
| GitHub hosting/auth/network states | **Mock** scenario switch, no requests; no identity leakage from real upstream snapshot to fictional fork |
| Local diffs and file selection | **Mock** code samples, no filesystem access |
| Remote selection / branch-PR association | **Mock** deterministic mapping |
| Terminal and bottom Capsule | **Approximate visual mock**, not production components/tokens |
| State changes, reset, scroll, keyboard | Actual browser JavaScript behavior over fixtures |
| Authentication, authorization, SSRF, API, codegen, cache, E2E | **Not implemented or verified** |

No model calls, secrets, network APIs, remote write actions, real Session IO, persistent state or real GitHub login. Both terminal lines and remote repository identifiers are fictitious demonstration data.

## Deterministic smoke checks

From this directory:

\`\`\`sh
node --check app.js
node smoke-test.mjs
\`\`\`

The dependency-free VM smoke runner exercises initial Terminal, context list, direct Git navigation, no intermediate Peek, Repository tabs, **real snapshot Issue/PR selection, Markdown escaping and article content, list↔detail↔focus-reading controls, filters, fork isolation**, Actions scope, error scenarios, local fallback and Reset. These checks are **mock behavior only**. A browser screenshot and narrow viewport clickthrough must be recorded separately before reporting "browser verified".

The shared Pages publisher copies only the allowed static assets and injects a **View source** link pointing at the exact published commit. When publishing, verify [manifest.json](https://bestnathan.github.io/nession/prototypes/manifest.json) \`source.sha\` against the shared \`prototype\` branch HEAD and inspect the actual HTML response; an updated GitHub source commit **does not** prove Pages is already showing it.

## Non-goals

No AI Workspace Scene/router, no AI Conversation directives, no local Git mutations (#845), no GitHub write operations, no Generic GitHub UI, no new auth UI, no competing capsule system or production implementation. No revision of other capabilities' Peek behavior.

## Product decisions left for review

- Is **Repository / GitHub** as two primary contextual areas sufficiently clear on both Web and phone, or should the same two levels be displayed as a nested list on mobile?
- Should Remote selection remain in the hosting header or be exposed only on ambiguous identity?
- Should Actions default to **Current branch** or **Repository-wide** latest? The prototype defaults to current branch for non-misleading CI interpretation.


## Recorded GitHub source provenance

These were read through the repository's connected GitHub API on **2026-10-28** and frozen as **public read-only fixtures** in [fixtures.js](fixtures.js):

- Issues: [#1290](https://github.com/BestNathan/nession/issues/1290) — this requirement; [#2514](https://github.com/BestNathan/nession/issues/2514) — Agent process discovery; [#2323](https://github.com/BestNathan/nession/issues/2323) — staging/CI acceptance.
- Pull requests: [#2229](https://github.com/BestNathan/nession/pull/2229) — open, `fix/ci-just-verified-archive`; [#2222](https://github.com/BestNathan/nession/pull/2222) — draft; [#2518](https://github.com/BestNathan/nession/pull/2518) — merged Pages prototype signal; [#2522](https://github.com/BestNathan/nession/pull/2522) — merged tmux sizing fix.

Snapshot metadata: number, title, author login, public labels, state/draft/merged, updated time, public URL, PR head/base, diff counts, and **the captured Markdown body**. Links labeled **Open on GitHub** go to those existing public records. Sources may change after capture; status and comments are **not live**. Local Git files, Session details, workflow executions, host remotes and failure responses remain synthetic. No private repo content, tokens, cookies or user-specific GitHub session state are embedded.

## Reader UX decision (revision)

**Open question resolved in the mock:** a two-pane desktop layout avoids replacing the whole workspace every time a user opens a long issue or PR, while **independent scrolling** prevents a 40K-character issue from forcing the list out of view. Mobile has insufficient width to preserve both columns, so selection enters a single-column detail reader rather than rendering narrow text. Detail toolbar always identifies the record and offers external source, with **read-only** semantics. Focus reading exists for long reports without elevating detail into another Workspace capability.

**Not yet decided for production:** precise breakpoint and 36% list width, whether selection should be URL-addressable, optional Markdown enhancements (tables, task lists, media), PR checks/comments/diff navigation, and whether a foldable detail outline adds enough value. A real browser UX review should settle these before production coding.
