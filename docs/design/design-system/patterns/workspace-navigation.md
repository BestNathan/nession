# WorkspaceNavigation

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [workspace.md](../../workspace.md)

WorkspaceNavigation is the interaction pattern for moving through **contextually relevant Workspace capabilities and resources**.

It is a capability capsule in the bottom Capsule Zone, and it is not a second application shell.

> Contract: `design/contracts/patterns/workspace-navigation.json` ([contracts.md](../contracts.md)).

## Supersession: #1347 Capsule V2

This pattern previously required that direct chrome be **bounded to the contextually-justified set**, that everything else be disclosed through a `More`/`+` menu, and it stated as a rule that *capability registration never implies permanent navigation*.

**#1347 (Capsule V2) supersedes both.** The Workspace capsule now carries the capability list — every capability that has a Workspace view — as one bounded, internally-scrolling horizontal row, and the `+`/menu disclosure is gone from Workspace. The contract's `overflow` moved from `menu` to `scroll` in the same change; the design-source test that pinned it moved with it.

### Membership does not vary with the work (2026-10-02, owner decision)

This is a **second and separate reversal** — not part of #1347's — and it is recorded on its own because it replaces a rule this document carried for longer than Capsule V2 has existed.

An `unavailable` capability (presence `hidden`) used to be **dropped**. The old rule was *"unavailable capabilities render no dead slot"*, and the anti-pattern list called a disabled entry chrome *"advertising something that cannot be opened"*. It now **keeps its slot, drawn inert** on `disabled-foreground` — the role the design system defines for a control the user cannot act with, held to the 3:1 that keeps it from disappearing rather than to AA.

What changed the answer: Capsule V2 put the whole capability list in one row, so dropping a capability now means the row's **membership** changes as the work changes — an entry that vanishes and reappears is how a reader loses track of what the Workspace holds. The row now says "this exists, and you cannot use it here" rather than staying silent.

**What it costs, plainly.** The retired rule was not empty: a Session with no files now shows a permanently inert Files entry. The mitigation is that it is inert and legible as such — not a live control that fails, not a silent absence — and it still carries `data-capability-state="unavailable"` for anything that needs to reason about it.

What the supersession keeps, and what carries the old rules' weight instead:

| Old rule | What holds it now |
|---|---|
| Direct chrome is bounded | The **capsule** is bounded: it must stay inside the tool bar while its content scrolls. The bound is on the row's width, not on the entry count. |
| Registration never implies permanent navigation | A capability with no Workspace view contributes **no slot**. Visibility follows the view binding, not the registry. |
| Unavailable capabilities render no dead slot | **Reversed on 2026-10-02 — see the section above.** The capability keeps its slot and is drawn inert. What survives from the old rule is its reason: the entry is *not* a live control that fails, and it is not silent either. |
| Not a second application shell | Unchanged — the capsule is a bottom-zone control, not a sidebar and not a band above the capability. |

The tradeoff, stated plainly: a Workspace with many capabilities now shows many icons in one row, and that row scrolls. The earlier design preferred a small visible set. That preference is **no longer a rule of this pattern** — the anti-patterns below were narrowed to match, and what remains forbidden is a row that *grows the shell* rather than a row that holds many entries.

## Purpose

Help users reach the part of the Workspace that is useful to the current work without turning Workspace into a second application shell.

Navigation should be generated from Workspace context and capability state rather than extension registration alone.

Must not:

- render a slot for a capability that has no Workspace view — there is nothing to open and nothing to explain. (An `unavailable` capability *does* keep a slot and is drawn inert — see the membership note above; the difference is that it has a view to be unavailable *in*.)
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
| `unavailable` | **Its slot, drawn inert and disabled.** Resolves to `hidden` presence; the surface renders it on `disabled-foreground` rather than dropping it — see the membership note above. Reached some other way it still lands on the capability's own not-available state. |
| `available` | Its slot, carrying `available` |
| `relevant` | The same slot, carrying `relevant` — state is data on the entry, not a promotion into or out of the row |
| `active` | Selected state (dot) and scrolled into view; may also have Session-level presence |

For every state that has a slot, state is published on the entry (`data-capability-state`, `data-capability-presence`), so a capability's condition stays legible without the row changing size or membership as the work changes — `unavailable` included, since it keeps its slot drawn inert rather than being removed (see the membership note above). A capability does not become primary navigation merely because it is active. Current work remains primary.

## Presentation model

Nession owns how the currently useful Workspace set is presented. Acceptable patterns include:

- contextual sections;
- compact switching across the capability set;
- the capability capsule itself — the current Workspace answer (see the supersession note above);
- search / command palette;
- native navigation stack on App;
- focused entry from a Terminal capability Peek, preserving capability context;
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

When Workspace is entered from a Terminal Peek, navigation should open directly at the corresponding capability and focus, not at a generic Workspace home. For example, selecting `TerminalCapsule.tsx` from a Git Peek should open Git → Changes → that file's diff with the same repo/worktree/session context. See [../../capability-emergence.md](../../capability-emergence.md).

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

### The capsule is present at every depth (owner decision, 2026-10-03 — supersedes `#1051`'s dock rule)

**Supersession.** `#1051` said the switcher was the capability *root's* control: visible
at the root, absent over a pushed detail, on the reasoning that a peer-capability
switcher over a detail would be a second navigation owner beside that depth's Back.

The owner overturned the dock half of that on 2026-10-03, having used it: in the App
Files flow the capsule disappeared the moment a file was opened, so the Workspace lost
its capability context exactly when the user was deepest in a capability. The rule is
now:

```text
Files root       -> capsule visible
open App.tsx     -> capsule visible; the detail's Back is still its only leave
```

What survives from `#1051` is the **leave** rule, which was always the load-bearing
half: a pushed depth's own Back is that depth's one route out, and the shell's swipe
stands down while it is offered (`shellMayPage`). *Leaving* is one owner per depth;
*switching capabilities* is not leaving, and the capsule is a bottom-zone control, not
a bar for the depth.

Two consequences, replacing the old pair:

- The bottom clearance the capsule needs is **every depth's** clearance. A pushed
  detail's scrollers reserve the same trailing padding the root's do — the workspace
  publishes one measured inset (`--nession-workspace-content-bottom-inset`, from the bar's own
  geometry) and every Workspace scroller spends it, so the last line of a file, the
  last turn of a transcript and the last search hit can all be scrolled above the
  capsule.
- The Workspace capsule has **no `+`** (#1347): its targets are the capability list
  itself, and they are built from capability snapshots, so the row cannot become a
  resource-creation affordance. (The Conversation capsule on Terminal keeps its `+`
  as work disclosure — that is `terminal-capsule.md`'s control, a different owner.)

### Web: the capability capsule

Capability navigation on Web is a **capsule** of labeled slots — icon over name, one
fixed-width slot each, a long name wrapping inside its slot at the smaller label
size (owner follow-up, 2026-10-03) — in the bottom
Capsule Zone, with a dot marking the open one. It carries every capability that has a
Workspace view and is not `unavailable` (#1347). The capsule's width is bounded and the
row scrolls internally, so the shell does not grow when an extension registers. The
glyph is drawn bare (`icon-md`): the painted 36px circle is the icon *button*'s
affordance, and a labeled entry is a tab whose affordance is the icon-plus-name pair;
the entry's own band is `capabilityEntryHeight` (40px on Web).

**No shell band above the capability area.** `workspace.md` is explicit that a
capability's own layout belongs to the capability — Files' master/detail *"belongs
to Files"* — so a band above every capability is the *"second application shell"*
this document forbids at the top. Context is carried by the tree's root row
instead: the tree starts at `nession`, so the root row states what the user is
looking at without a chrome band restating it.

### The App Capsule family (owner decision, 2026-10-03)

On App there is **one Capsule with two states**, and the state decides only what
is inside it:

```text
Terminal page   -> Conversation Form   [ + | Ask Nession… | Send ]
Workspace root  -> Capability Form     [ Files | Git | Claude | … ]
```

Surface navigation stays with the App's spatial model (swipe) plus the existing
shell/header fallback — the Capsule Zone adds **no** Terminal/Workspace
destination circles, unlike Web's reciprocal pair, and that difference is
experience presentation, not a divergence in the Capsule's identity.

What the two states **share** is the outer geometry: the floating surface and
elevation, the semantic capsule radius (`--nession-radius-capsule`), the App dock's
bottom and safe-area-aware placement, the shell's inner padding rhythm — and,
after the owner correction of 2026-10-03, the band itself. The labeled entries
take `capabilityEntryHeight`, the same 44px row the composer uses, so both
states measure **56px** on App; the shape claim, the semantic radius, the
placement and the height are all compared relationally (SC-30). The correction
is a correction: the first labeled build let the entries carry their own
vertical mass and the form grew to 82px, which read as a different object
sitting in the same slot ("太高了").

What they **do not** share is content — a composer on one, the labeled
capability slots on the other. A label that genuinely needs two lines may
still grow its entry by its own line box rather than clip, but no shipped
capability does that (measured 2026-10-03: every title is one line at the
labeled sizes), so the band holds in practice and the relational assertion
holds with it.

Two questions the previous revision left open, now settled by the same decision:

- **Where the band floats.** The band was described as floating "over the
  terminal", but it is rendered by `WorkspaceShell` and mounts on the Workspace
  page. It floats over whichever surface owns it — the Conversation Form over
  the Terminal, the Capability Form over the Workspace. They are the same
  Capsule at the same place on both pages, which is what makes a surface switch
  read as one object rather than two components.
- **The touch floor.** The App capability band used to declare its own compact
  floor — `experience.app.touchTarget.compact` (28px, #730), with
  `dockTarget` as its twin — on the reasoning that it was a legacy dock
  borrowing space from the terminal. Once the two states are one Capsule, that
  exception has no owner: the entries take the standard App control band like
  every other Capsule control, `control.md` (44px) hit target with the
  `control.visualSize` (36px) circle drawn inside it (#1034). The
  `touchTarget.compact` / `dockTarget` vocabulary **retired with the decision**
  rather than being protected; the pattern declares no override, so the
  viewport matrix enforces `category.chrome`'s
  `experience.app.touchTarget.min` (44px) on every App viewport.

`#748`'s yielding rule survives in the shape the one-Capsule model gives it: the
Capability Form does not shrink or shift for a pushed depth — it stays, at the
same band, over the detail (owner decision 2026-10-03, "the capsule is present
at every depth"); the depth's own content is what moves, clearing the capsule
with its trailing scroll padding. The Conversation Form keeps its own sizing
from `terminal-capsule.md`.

The narrowest supported App viewport is `app.narrow-phone` (375×812, from
`design/contracts/viewports.json`), and the family is verified there: both
states at the canonical App viewports, plus the relational assertion that
compares them as one Capsule rather than verifying each alone (#1347 SC-30).

## Files and other capability-specific layouts

Files may use master/detail on Web and push navigation on App. That composition belongs to Files.

Claude Code may use state/history/configuration views. Git may use repository status and change navigation. Agent/location detail may use an information surface.

WorkspaceNavigation coordinates access; it does not force these capabilities into the same content layout.

## Visual grammar ownership (#1451)

Workspace navigation is the second product family, after Capsule, to make the
repository-wide visual invariant stack executable.

Its ownership chain is:

```text
--nession-* vocabulary
        ↓
shared primitives / Capsule geometry
        ↓
workspaceNavigationStyles
        ↓
CapabilityCapsule composition
        ↓
capability identity + state
```

Nession owns the Workspace navigation surface, entry geometry, radius,
typography treatment, disabled/active affordance, indicator and motion. A
capability contributes identity/state and its Workspace body; it does not
redefine the global switcher's chrome.

Selection is explicitly a **state change inside one visual grammar**, not a new
recipe. The browser matrix measures one entry before and after it becomes active
and requires width, height, radius, padding and label typography to remain
identical. State may change semantic color/presence only.

The canonical recipe owner is:

```text
web/src/product/workspace/patterns/workspaceNavigationStyles.ts
```

Consumers must not reproduce its radius/type/motion decisions inline. New visual
behavior belongs there as an explicit semantic variant when it represents a real
Workspace-navigation distinction.

All direct custom-property consumption uses the repository namespace:

```text
--nession-*
```

Framework utilities such as `text-foreground` remain legal only because the
generated theme bridge resolves them back to that vocabulary.

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
- A slot for a capability that has no Workspace view — nothing to open, nothing to explain.
  (An inert entry for an `unavailable` capability is *not* this: it has a view, it says so,
  and it is why this anti-pattern was narrowed on 2026-10-02.)
- A disabled entry drawn as a live one — an inert control must read as inert. Its
  treatment is `disabled-foreground` and `disabled`, never a normal entry that silently
  does nothing when pressed.
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

- [ ] A capability with no Workspace view contributes no slot; an `unavailable` one keeps its slot, drawn inert and disabled.
- [ ] Capability state and presence are legible from the entry without changing the row's membership.
- [ ] Workspace root communicates context, not a global feature catalog.
- [ ] Extensions cannot independently fragment the global navigation model.
- [ ] Web/App may present the same capability differently while preserving semantic state.
- [ ] The App entries meet the chrome touch floor (`experience.app.touchTarget.min`, 44px) — the pattern declares no compact override since the 2026-10-03 Capsule-family decision — enforced by the viewport matrix.
- [ ] The App Capability Form and Conversation Form share one outer geometry — radius, shape claim, dock placement **and the 56px band** (`capabilityEntryHeight` = the composer's `control-md` row) — asserted relationally rather than each alone (#1347 SC-30).
- [ ] The capability capsule's row owns its horizontal drags: panning it never pages the shell, and only the shell's own edge bands remain a navigation start over it.
- [ ] The capsule is present at every Workspace depth, pushed detail included, and each depth's scrollers can bring their last line above it (owner decision 2026-10-03, superseding `#1051`'s dock rule).
- [ ] Files-specific layout remains local to Files.
- [ ] The capsule stays inside the tool bar at every viewport, and its row scrolls internally.