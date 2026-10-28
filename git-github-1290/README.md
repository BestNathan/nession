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
4. Change to **GitHub → Issues**; filter open/closed/all, search, select a detail. Change to **Pull Requests** and inspect the current-branch matched PR (head repository + branch, not just branch text).
5. Switch the discovered **Remote** from **upstream / demo-org** to **origin / demo-fork**: repository identity changes and current-branch PR matching is no longer falsely asserted for the fork.
6. Open **Actions**; toggle **Current branch** vs **Repository** latest-run scope. An unrelated green main workflow is not allowed to imply current-branch success. Observe disabled and no-runs states.
7. In the bottom **Prototype controls**, use **Scenario** to try Multiple remotes (choose one of the Agent-discovered choices), No GitHub remote, Authentication required, Access denied, Rate limited, Network unavailable, Empty repository and Never executed. GitHub's failure must not block **Repository**.
8. Press **Refresh** for an explicit simulated snapshot counter; inspect state/event log; return to the same Terminal via the Capsule circle, or press Escape. **Reset** returns to initial Terminal.

## Interaction and responsive contract

- **Entry:** one Git capability; Terminal context disclosure -> direct Git Workspace; Workspace Capability Capsule -> direct Git Workspace. No Git Peek and no independent GitHub capsule entry.
- **Layout:** primary Repository vs GitHub hierarchy, secondary tabs only within the selected section, readable detail area; mobile single-column content and touch-sized controls. The bottom Capsule overlays content, not a persistent toolbar row, with scroll clearance for the trailing content.
- **Visibility:** only the chosen category is rendered. The mock does not make background API requests or invoke interval polling.
- **Errors:** no remote, ambiguous remote, auth, denied, rate limit, offline are distinct. All leave local Git accessible. Empty/no-runs are **valid empty outcomes**, not failures.
- **Focus/return:** active Session identity persists when moving Terminal ↔ Workspace; route into the Git Workspace is direct with no intermediate view. Keyboard Tab/focus-visible and Escape support the demo. This is a **mock approximation**, not verified React/Capsule focus management.
- **Safety:** no GitHub write actions, no real OAuth/secret fields, no production origin/Agent endpoints, no arbitrary host selector or external API calls.

## Fixture and fidelity

| Concern | Fidelity |
|---|---|
| Agent, Session, branch, files, Issues, PRs, Actions, remote identities | Public-safe **synthetic fixtures** |
| GitHub hosting/auth/network states | **Mock** scenario switch, no requests |
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

The dependency-free VM smoke runner exercises initial Terminal, context list, direct Git navigation, no intermediate Peek, Repository tabs, GitHub lists, remote swap, Actions scope, error scenarios, local fallback and Reset. These checks are **mock behavior only**. A browser screenshot and narrow viewport clickthrough must be recorded separately before reporting "browser verified".

The shared Pages publisher copies only the allowed static assets and injects a **View source** link pointing at the exact published commit. When publishing, verify [manifest.json](https://bestnathan.github.io/nession/prototypes/manifest.json) \`source.sha\` against the shared \`prototype\` branch HEAD and inspect the actual HTML response; an updated GitHub source commit **does not** prove Pages is already showing it.

## Non-goals

No AI Workspace Scene/router, no AI Conversation directives, no local Git mutations (#845), no GitHub write operations, no Generic GitHub UI, no new auth UI, no competing capsule system or production implementation. No revision of other capabilities' Peek behavior.

## Product decisions left for review

- Is **Repository / GitHub** as two primary contextual areas sufficiently clear on both Web and phone, or should the same two levels be displayed as a nested list on mobile?
- Should Remote selection remain in the hosting header or be exposed only on ambiguous identity?
- Should Actions default to **Current branch** or **Repository-wide** latest? The prototype defaults to current branch for non-misleading CI interpretation.
