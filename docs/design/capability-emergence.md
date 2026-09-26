# Progressive Capability Disclosure

> Upstream: [`VISION.md`](../../VISION.md) → [`PRINCIPLE.md`](../../PRINCIPLE.md) → [product model](product-model.md) → [information architecture](information-architecture.md)

Nession capabilities should **emerge in proportion to the user's current need**.

The Terminal is the current-work surface. It may expose small, contextual projections of a capability, but it should not become the place where the capability's complete information architecture is reproduced. Rich state, history, management, configuration, and full workflows belong in Workspace.

This document defines the canonical disclosure model shared by Web and App.

## Two independent dimensions

Capability **lifecycle** and capability **disclosure depth** are separate concepts.

Lifecycle answers whether a capability exists and matters:

```text
unavailable -> available -> relevant -> active
```

Disclosure depth answers how much of that capability Nession is currently showing:

```text
Dormant -> Signal -> Peek -> Workspace
```

A capability may be `active` while still showing only a `Signal`, or it may be merely `relevant` but opened explicitly into a `Peek`. Do not collapse lifecycle state and presentation depth into one enum.

## Disclosure levels

### L0 — Dormant

No Session-level UI is shown.

The capability may still be available in Workspace or discoverable through an explicit capability entry, but it does not occupy the Terminal.

### L1 — Signal

A compact, mostly read-only indication that answers:

> **What about this capability matters right now?**

A Signal should normally contain only the smallest identifying state needed to understand why the capability has emerged.

Examples:

- Git: branch, worktree identity, dirty/change count, ahead/behind.
- Claude Code: active/running state, current task summary.
- Workspace context: current logical workspace/location identity when that distinction matters.

A Signal is not a toolbar and is not a list of actions.

### L2 — Peek

A small Session-scoped contextual surface that answers:

> **What is happening here, and do I want to go deeper?**

Peek may contain a concise summary and one or two contextual interactions, but it must remain subordinate to the Terminal.

Typical constraints:

- summarize, do not replicate the full Workspace capability UI;
- prefer current-state information over long history;
- no large management forms;
- no permanent navigation tree;
- provide an explicit path into Workspace when deeper inspection is useful;
- preserve the Session, Workspace, location, and selected item when transitioning deeper.

### L3 — Workspace

Workspace is the capability's full contextual surface.

This is where richer information and management belongs:

- full resource lists;
- detailed state;
- history;
- configuration;
- multi-step workflows;
- capability-specific navigation;
- large diffs, graphs, inspectors, forms, and management operations.

Workspace is not a feature lobby. It is the high-density contextual layer for the current work.

## TerminalCapsule relationship

The resting TerminalCapsule remains minimal.

```text
┌──────────────────────────────────────┐
│ [+]  Ask Nession…                [↑] │
└──────────────────────────────────────┘
```

The resting capsule must not grow one persistent chip per active capability.

The `+` affordance is the explicit entry for **peeking** at a capability from the Terminal. It is **not a launcher**: selecting an item never changes surface, and a capability whose only depth is a Workspace view is not listed at all (#1046 — see *What may appear* below). That supersedes the earlier reading of this sentence, which made `+` a fallback for *invoking* capabilities. `+` is still **not the only place capability state may ever be shown**.

Once a capability has been selected, triggered, or has earned contextual presence, Nession may materialize a temporary Signal or Peek adjacent to the capsule while keeping the resting capsule itself unchanged.

This refines the 2026-09-16 #748 decision:

- **still valid:** capability state must not become permanent resting-capsule chrome;
- **superseded:** the stronger claim that capability state may only exist inside the `+` expansion.

The stable rule is now:

> **No permanent capability chrome on the resting capsule. Contextual capability projections may emerge around it, then deepen into Workspace.**

## Capability entry

The `+` expansion is a Nession capability entry, not an operating-system action menu.

Platform-native text actions such as copy/paste/selection should remain native platform behavior rather than being duplicated as first-class Nession capabilities.

The capability entry should show only capabilities that Nession owns or integrates, filtered by context, support, **and Terminal depth**.

It must not become a static catalog of everything installed.

Examples may include:

- Claude Code;
- Workspace context;
- Git;
- Terminal Keys;
- future debugging, database, Kubernetes, preview, process, or environment capabilities.

### What may appear, and what may not (#1046)

> **A capability is eligible for the capsule entry only if it contributes a useful Terminal-local Peek. Availability in Workspace is not enough.**

Eligibility is declared by the capability, beside the body that does the peeking, as one of three roles:

| role | listed | why |
|---|---|---|
| **Peek** | yes | it can be reached from where the user already is |
| **Accessory** | yes | a built-in Terminal-local accessory; it has no Workspace view to be confused with, and it keeps the entry from being empty on a node whose only Peek-capable capability is unavailable |
| **Signal** | no | it emerges by observation when Nession resolves it as relevant, but explicit discovery is not offered for a depth with nothing behind it |

The examples above are therefore a list of **capabilities**, not of entry items: Claude Code is Signal-only and is not listed today, and returns to the entry when it contributes a Peek. Git and Terminal Keys are listed.

There is no path from selecting an entry to changing surface. Not "the control is hidden" — the entry cannot offer a capability that has no Terminal depth, so the branch does not exist.

A capability with a Workspace view and nothing else stays reachable through Workspace navigation, which is where it belongs.

## Capability projection contract

Conceptually, a capability contributes one semantic capability and multiple projections.

```ts
type CapabilitySurface = "terminal" | "workspace"
type DisclosureDepth = "signal" | "peek" | "workspace"

interface CapabilityProjection {
  capabilityId: string
  lifecycle: "available" | "relevant" | "active"
  depth: DisclosureDepth
  contextRef: CapabilityContextRef
}

interface CapabilityContextRef {
  workspaceId?: string
  locationId?: string
  sessionId?: string
  resourceId?: string
  focus?: string
}
```

This is illustrative, not a required implementation API.

The product contract is:

- the capability provider owns semantic state;
- Nession owns when and where projections appear;
- a Terminal projection is intentionally shallower than a Workspace projection;
- transitions preserve context instead of asking the user to reselect the same repo, worktree, file, task, or Session;
- Web and App may render different densities while preserving the same meaning.

## Context-preserving deepening

Moving from Peek to Workspace is not generic navigation to a feature homepage.

The transition must carry the context that caused the capability to emerge.

Example:

```text
Session
  repo = nession
  worktree = capsule
  branch = feature/capsule
  capability = git
  focus = changes
```

Then:

```text
Git Peek
    ↓ Open in Workspace
Workspace / Git
  repo = nession
  worktree = capsule
  focus = changes
```

If the user selects a specific changed file in Peek, Workspace should open directly at that file's diff rather than returning to a generic Git landing page.

## Reference flow: Git

Git is the first complete reference example for this model.

### 1. Dormant

The user is working in Terminal. Git is available, but nothing about it currently needs attention.

```text
Terminal

$ cargo test
...

┌──────────────────────────────────────┐
│ [+]  Ask Nession…                [↑] │
└──────────────────────────────────────┘
```

### 2. Capability entry

The user taps `+`, or Git becomes a highly relevant capability.

```text
Nession capabilities

Claude Code
Workspace
Git
Terminal Keys
```

Selecting Git does not open a full Git client inside the Terminal.

### 3. Git Signal

Nession exposes a small current-state projection:

```text
Git
feature/capsule · worktree: capsule
3 changed · ↑2 ↓0
```

This answers the immediate question without stealing the work surface.

### 4. Git Peek

The user taps the Signal or explicitly asks for more.

```text
┌─ Git ────────────────────────────────┐
│ feature/capsule                      │
│ worktree: capsule                    │
│                                      │
│ 3 changed                            │
│ 1 staged · 2 unstaged                │
│ ↑2 ↓0                                │
│                                      │
│ M TerminalCapsule.tsx                │
│ M useCapsuleState.ts                 │
│ A GitProjection.tsx                  │
│                                      │
│                     Open Workspace → │
└──────────────────────────────────────┘
```

Peek may show a short changed-file summary because those files explain the current state. It should not render a full diff, commit graph, branch manager, or history browser.

### 5. Git Workspace

`Open Workspace` deepens into the same capability with preserved context.

```text
Workspace / Git

┌──────────────┬──────────────────────────────┐
│ Changes      │ TerminalCapsule.tsx          │
│ History      │                              │
│ Branches     │ diff --git ...               │
│ Worktrees    │ - previous line              │
│              │ + current line               │
│              │                              │
└──────────────┴──────────────────────────────┘

feature/capsule · worktree: capsule · ↑2 ↓0
```

Workspace may now expose:

- repository status;
- complete changed-file list;
- file diff;
- staging/unstaging;
- commit authoring;
- commit history;
- branches;
- worktrees;
- ahead/behind;
- conflict state;
- capability-specific search/filtering.

The exact Git information architecture may evolve independently, but the Terminal-to-Workspace depth boundary must remain.

## Web and App

The semantic progression is shared:

```text
Dormant -> Signal -> Peek -> Workspace
```

Presentation differs by experience.

### App

- Signal/Peek should remain compact and thumb-friendly.
- Peek may use a floating glass surface above the capsule.
- `Open Workspace` should enter the App's Workspace side of the `Sessions ← Terminal → Workspace` spatial model.
- Back/dismiss returns to the same Session and Terminal position.

### Web

- Signal/Peek may use slightly higher information density.
- A Peek may show several changed files where App shows only counts.
- `Open Workspace` switches the current-work surface into Workspace while preserving Session identity.
- The full Git capability may use a master/detail layout inside Workspace.

Do not fork capability semantics by viewport.

## Terminal-local capability exception

Not every capability needs a Workspace projection.

Terminal Keys is a Terminal-local capability.

```text
Terminal Keys
  terminal: interactive accessory
  workspace: none
```

Its full useful interaction is already local to Terminal.

On touch devices, Terminal Keys should preserve a stable left/right structure:

```text
┌─ Terminal Keys ─────────────────────────────┐
│ Esc  Tab  Ctrl             ↑               │
│ Cmd  Shift Alt          ←  ↓  →            │
└─────────────────────────────────────────────┘
     function / combo       directional
```

Opening Terminal Keys does not replace the intent composer and does not imply a Workspace transition.

## Anti-patterns

- Rendering full Git diff/history/branch management inside the Terminal capsule.
- Treating `+` as an app launcher containing every installed feature.
- Duplicating native copy/paste/selection actions as Nession capabilities.
- Showing action buttons before showing the state that makes those actions meaningful.
- Navigating from Git Peek to a generic Workspace homepage and losing repo/worktree/file context.
- Giving Web and App different lifecycle or disclosure semantics.
- Automatically opening Workspace merely because a capability becomes relevant.
- Treating Signal or Peek as permanent chrome.

## Design review checklist

For every capability integration, ask:

- What is the smallest useful Signal?
- What additional information makes a useful Peek?
- What information/actions are explicitly too rich for Terminal and therefore belong in Workspace?
- What exact context is preserved when deepening?
- Can the user return to the same Session without rebuilding context?
- Does the capability support Terminal, Workspace, or both?
- Does the resting capsule remain unchanged?
- Is the capability entry contextual rather than exhaustive?
