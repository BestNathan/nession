# WorkspaceNavigation

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [workspace.md](../../workspace.md)

WorkspaceNavigation is the interaction pattern for moving through **contextually relevant Workspace capabilities and resources**.

It is a capability capsule in the bottom Capsule Zone, and it is not a second application shell.

> Contract: `design/contracts/patterns/workspace-navigation.json` ([contracts.md](../contracts.md)).

## Supersession: #1347 Capsule V2

This pattern previously required that direct chrome be **bounded to the contextually-justified set**, that everything else be disclosed through a `More`/`+` menu, and it stated as a rule that *capability registration never implies permanent navigation*.

**#1347 (Capsule V2) supersedes both.** The Workspace capsule now carries the capability list — every capability that has a Workspace view *and* is not `unavailable` — as one bounded, internally-scrolling horizontal row, and the `+`/menu disclosure is gone from Workspace. The contract's `overflow` moved from `menu` to `scroll` in the same change; the design-source test that pinned it moved with it.

**It supersedes those two rules and no others.** The row is not a licence to advertise everything: "an unavailable capability renders no slot" is *not* part of what #1347 replaced, and it still decides the row's membership. Read the table below before concluding the capsule shows "all capabilities" — it shows all *callable* ones.

What the supersession keeps, and what carries the old rules' weight instead:

| Old rule | What holds it now |
|---|---|
| Direct chrome is bounded | The **capsule** is bounded: it must stay inside the tool bar while its content scrolls. The bound is on the row's width, not on the entry count. |
| Registration never implies permanent navigation | A capability with no Workspace view contributes **no slot**. Visibility follows the view binding, not the registry. |
| Unavailable capabilities render no dead slot | **Unchanged by #1347 — and still the row's second membership rule.** `unavailable` resolves to `hidden` presence, and `resolveCapabilityDisclosure` drops `hidden` before either bucket, so no entry is built. `WorkspaceShell.test.tsx` pins it: *does not advertise unavailable capabilities in direct chrome*. |
| Not a second application shell | Unchanged — the capsule is a bottom-zone control, not a sidebar and not a band above the capability. |

The tradeoff, stated plainly: a Workspace with many capabilities now shows many icons in one row, and that row scrolls. The earlier design preferred a small visible set. That preference is **no longer a rule of this pattern** — the anti-patterns below were narrowed to match, and what remains forbidden is a row that *grows the shell* rather than a row that holds many entries.

## Purpose

Help users reach the part of the Workspace that is useful to the current work without turning Workspace into a second application shell.

Navigation should be generated from Workspace context and capability state rather than extension registration alone.

Must not:

- render a slot for a capability that has no Workspace view, or for one that is `unavailable` — a dead entry advertising something that cannot be opened;
- let the row grow the shell: the capsule's width is bounded and its content scrolls, so registering another capability never widens the chrome and never wraps the row onto a second line;
- force Files master/detail chrome onto unrelated capabilities;
- allow an extension to define global Workspace navigation independently of Nession;
- become a second full-height app sidebar by default.

## Product model

Workspace content can include resources, locations, infrastructure context, and extension capabilities.

The capability lifecycle is:

```text
unavailable -> available -> relevant -> active
```

Navigation consequences:

| State | Navigation behavior |
|-------|---------------------|
| `unavailable` | **No slot.** Resolves to `hidden` presence, which is dropped before the row is built — see the supersession table above. The capability keeps its own not-available state for whatever opens it directly. |
| `available` | Its slot, carrying `available` |
| `relevant` | The same slot, carrying `relevant` — state is data on the entry, not a promotion into or out of the row |
| `active` | Selected state (dot) and scrolled into view; may also have Session-level presence |

For every state that has a slot, state is published on the entry (`data-capability-state`, `data-capability-presence`), so a capability's condition stays legible without the row changing size or membership as the work changes. `unavailable` is the one state that changes membership — and it *removes* the entry rather than dimming it. A capability does not become primary navigation merely because it is active. Current work remains primary.

## Presentation model

Nession owns how the currently useful Workspace set is presented. Acceptable patterns include:

- contextual sections;
- compact switching across the capability set;
- the capability capsule itself — the current Workspace answer (see the supersession note above);
- search / command palette;
- native navigation stack on App;
- focused entry from a Terminal capability Signal/Peek, preserving capability context;
- location/resource-driven navigation when the Workspace contains multiple physical contexts.

The implementation may combine these patterns. No one widget is the product model.

## Capability contribution

Conceptually, a capability contributes semantic data:

```ts
interface WorkspaceCapability {
  id: string
  title: string
  state: (context: CapabilityContext) => CapabilityState
}
```

The exact API is implementation-specific. What a capability contributes is its
semantic identity and state — a summary, an action list, or a self-declared view
descriptor is not part of the contract, because each of those is a placement
decision wearing a semantic name.

Important boundary:

> Extensions contribute capability. Nession decides whether, where, and how that capability is navigated.

Do not let a plugin select its own permanent tab position, accent color, or global navigation structure as part of the extension contract.

## Workspace root

The Workspace root should communicate the work context before it communicates the tool catalog.

Depending on context it may surface:

```text
Workspace
├── resources / files
├── repository state
├── active or relevant capabilities
├── Workspace Locations
└── infrastructure/context details on demand
```

A Workspace with only Files should not look like a five-tool product with four missing buttons. A Workspace with Git and an active coding agent may surface those because the work context justifies them.

When Workspace is entered from a Terminal Signal/Peek, navigation should open directly at the corresponding capability and focus, not at a generic Workspace home. For example, selecting `TerminalCapsule.tsx` from a Git Peek should open Git → Changes → that file's diff with the same repo/worktree/session context. See [../../capability-emergence.md](../../capability-emergence.md).

## Web

Web presents capabilities as a **bounded capsule of icon targets** in the bottom Capsule Zone, with the open one marked and scrolled into view. The row does not imply a closed tool enum: it is generated from capability snapshots, so registering a capability adds a target rather than changing the shell.

Overflow is internal scrolling, not a menu (#1347).

A persistent full-width inner sidebar remains a non-default pattern because it competes with the work surface.

## App

App should prefer native spatial and push/pop interaction:

- Workspace opens as contextual depth from the active Session;
- the Workspace root presents what is relevant now;
- tapping an item/capability pushes or overlays deeper detail;
- system/back navigation returns through capability detail before leaving Workspace;
- nested navigation must not fight the top-level `Sessions ← Terminal → Workspace` spatial model.

### The dock is the root's, not the stack's (`#1051`)

The capability switcher is the **capability root's** control. It is present where
switching between peer Workspace capabilities is conceptually valid — at the root — and
it is absent once the user pushes into capability-owned detail.

```text
Files root       -> dock visible
open App.tsx     -> dock hidden; the page belongs to Files' own navigation stack
```

The reason is the one-navigation-bar rule
([interaction/app.md](../../interaction/app.md#one-navigation-bar-per-depth)): a pushed
detail has its own header and its own Back, so a peer-capability switcher floating over
it would be a second navigation owner answering to a depth it has no place at. It would
also put "switch capability" and "leave this file" within one thumb reach of each other
while meaning opposite things.

Two consequences for the rest of the App:

- The bottom clearance the dock needs is the **root's** clearance. A pushed detail must
  not reserve permanent padding for a dock that is not there.
- The Workspace capsule has **no `+`** (#1347): its targets are the capability list
  itself, and they are built from capability snapshots, so the row cannot become a
  resource-creation affordance. (The Conversation capsule on Terminal keeps its `+`
  as work disclosure — that is `terminal-capsule.md`'s control, a different owner.)

This narrows the open question recorded below (where the band floats) without settling
it: the band is root-only on whichever page owns it.

### Web: the capability capsule

Capability navigation on Web is a **capsule** of rounded icon targets in the bottom
Capsule Zone, with a dot marking the open one. It carries every capability that has a
Workspace view and is not `unavailable` (#1347). The capsule's width is bounded and the
row scrolls internally, so the shell does not grow when an extension registers.

**No shell band above the capability area.** `workspace.md` is explicit that a
capability's own layout belongs to the capability — Files' master/detail *"belongs
to Files"* — so a band above every capability is the *"second application shell"*
this document forbids at the top. Context is carried by the tree's root row
instead: the tree starts at `nession`, so the root row states what the user is
looking at without a chrome band restating it.

### Open inconsistency: where the App band actually floats

This document (and #748 §6) describes the App band as a pill floating **over the
terminal**. In the implementation the band is rendered by `WorkspaceShell`, which
mounts on the Workspace page — so on App it floats over the *Workspace*, not the
terminal.

That matters beyond wording: #748 §7 asks for the band to hide when the capsule
expands, and the capsule lives on the Terminal page. If the two are never on
screen together, the rule has nothing to govern, and if the band is meant to
float over the terminal, it is in the wrong container.

Recorded rather than resolved — moving the band changes which page owns it and
what the App's two-layer stack means, and that is a product call, not a
consequence of the wording.

### Touch floor (recorded decision, #730, extended by #748)

The App band is a compact pill floating over the terminal, and it declares its own
touch floor — `experience.app.touchTarget.compact` (28px) — instead of the 44px
that `category.chrome` applies to chrome bands. The reasoning: chrome yields
before the work surface, the pill already floats *over* the terminal rather than
taking a row from it, and these entries are secondary controls reached
deliberately rather than in a hurry.

This is a floor, not a waiver: the contract states the size the pill is allowed to
be, the executable assertion enforces it at every App viewport, and shrinking it
further fails CI. What it does not claim is comfort — 28px is below the platform
guideline, and that cost is accepted in exchange for the terminal keeping its
space. If the pill ever gains a touch-first role, the token moves back to `min`
and the implementation has to grow with it.

**#748 extended the App band to two layers.** The band carries capability entries
*and* the TerminalCapsule; **when the capsule expands, the band hides.** Hiding —
not shifting, not shrinking — is what "yielding" means here: a partially visible
band competes with the expanded capsule for the same thumb reach and reads as two
half-controls rather than one. The 28px floor governs the capability layer; the
capsule keeps its own sizing from `terminal-capsule.md`.

The narrowest supported App viewport is `app.narrow-phone` (375×812, from
`design/contracts/viewports.json`). The two-layer stack is verified there, because
that is where it has the least room and where a band that merely shrinks would
first become unusable.

## Files and other capability-specific layouts

Files may use master/detail on Web and push navigation on App. That composition belongs to Files.

Claude Code may use state/history/configuration views. Git may use repository status and change navigation. Agent/location detail may use an information surface.

WorkspaceNavigation coordinates access; it does not force these capabilities into the same content layout.

## Visual contract

- Navigation chrome is secondary to active Workspace content and substantially secondary to Terminal when the user returns to the Session.
- The capsule stays inside the tool bar at every viewport; its row scrolls rather than crowding or clipping.
- Whitespace and hierarchy are preferred over card/tab proliferation.
- Per-capability branding must not fragment Nession's visual language.
- Active/relevant state may affect presence, but routine availability should remain quiet.

## Anti-patterns

- A capability strip that **grows the shell** — widening with the registry, or wrapping
  onto a second line. The failure is the growing row, not the number of entries in a
  bounded, scrolling one.
- A slot for a capability that has no Workspace view, or a disabled entry advertising
  something that cannot be opened.
- One extension = one global tab.
- A Workspace home page that is mostly a grid of feature launch cards.
- A full-height secondary sidebar that exists only to list capabilities.
- Tool-specific accent colors used as navigation identity.
- Hard-coded closed enums that require shell changes for every extension.

## Migration from the current implementation

The current Session-first UI introduced a registry-driven Workspace tool bar/list for Files, Session, Agent, and extension tools. The registry remains useful; what #1347 changed is where the boundary sits:

```text
old: registered -> permanent navigation presence      (withdrawn by #1347)
now: registered -> capability -> view binding -> capsule entry
```

Registration alone still buys nothing: a capability appears only once it has a Workspace view, and the row stays a fixed-width, internally-scrolling container however many entries it holds.

Existing components should migrate incrementally. Do not remove reliable capability views merely to satisfy a document; first separate capability contribution from navigation placement, then converge the shell.

## Acceptance for future implementation work

- [ ] A capability contributes no slot when it has no Workspace view **or** when it is `unavailable`.
- [ ] Capability state and presence are legible from the entry without changing the row's membership.
- [ ] Workspace root communicates context, not a global feature catalog.
- [ ] Extensions cannot independently fragment the global navigation model.
- [ ] Web/App may present the same capability differently while preserving semantic state.
- [ ] The App band meets its declared compact touch floor (`experience.app.touchTarget.compact`), enforced by the viewport matrix.
- [ ] The capsule appears only at capability-root depth, and is absent over capability-owned detail.
- [ ] Files-specific layout remains local to Files.
- [ ] The capsule stays inside the tool bar at every viewport, and its row scrolls internally.