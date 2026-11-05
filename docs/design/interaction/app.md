# App Interaction Model

> Upstream: [`VISION.md`](../../../VISION.md) → [`PRINCIPLE.md`](../../../PRINCIPLE.md) → [product model](../product-model.md) → [information architecture](../information-architecture.md)

App shares the same product semantics as Web but uses a mobile-native spatial interaction model. It is not a responsive shrink of the Web layout.

## Spatial model

```text
Navigation             Current Work             Contextual Depth

 Sessions     ←──────    Terminal    ──────→      Workspace
```

Default focus is the active Session's Terminal. **Before any Session exists there is no
Terminal**, and the App's root is a home instead — see *The no-Session root* below.

Conceptually:

```text
Navigation  ←  Work  →  Context
```

This is a navigation relationship, not a claim that Workspace is a static feature page,
and it is a statement about the **product** rather than about how the App is built. The
App is not required to render a pager, a carousel, or three permanently translated pages.
What the model constrains is where the user can go and what is adjacent to what — not the
mechanism that gets them there.

## Terminal-first Session surface

When the user creates or attaches to a Session, the Terminal should occupy the working canvas.

The surrounding UI stays quiet. Session identity, connectivity, and controls are visible only to the degree needed to understand or recover the work.

The App should feel like returning to an active place of work, not entering a management dashboard.

**The Terminal is the root of a selected Session.** Sessions and Workspace are reached
*from* it and return to it, and while either is open the Terminal stays mounted
underneath. This constrains the implementation, not only the look: a navigation event must
not unmount the Terminal, because unmounting rebuilds xterm, the attach state and the
scrollback, and turns "return to where I was" into a state-restoration problem. Layers,
drawers and pushed views satisfy this by construction. A translated pager satisfies it
only by keeping every page mounted at all times — which worked, but also meant the App
rendered two page headers and two sets of navigation controls at all times, and gave the
shell no way to say which page was current.

## The Sessions layer at rest

The Sessions layer is a **navigator**, and its resting composition is one screen with
one job: pick or start work (#1083).

It is also a **full spatial layer, never a collapsible sidebar** (#1196 §8). The Web
shell may tuck its navigation column into a compact rail; the App has no such concept —
no collapse control, no expand control, no icon-strip rail. Leaving and opening
Sessions belongs to the App's spatial navigation (Session selection and its visible
navigation affordances), not to a width state.

```text
Sessions                         ＋        ← the page's name and its one action
[ search ]                          ⚙︎     ← the only persistent control row
Today · Previous 7 days · Older           ← history, grouped by when it happened
  session name
  workload · agent
Agents · N online                 ⌄       ← secondary, below history
```

What that rules out, each because it made the screen read as a management console
rather than a history list:

- **No infrastructure leading the page.** Agents sit below history, not above it —
  the App's dominant object is the Session, not the Agent
  (`information-architecture.md`: "infrastructure context stays quiet when healthy").
- **No permanent filter or refresh row.** Filters are behind the field's own control,
  with a removable chip while one is active; a manual refresh belongs to the failure
  that makes it useful, not to the resting screen.
- **No service footer while healthy.** A live connection is not news. When it is
  degraded the layer grows a compact problem row carrying the state and the retry, and
  that row is *absent* rather than empty when healthy.
- **Two metadata fragments per row, not three.** Time is stated by the group label, so
  a row repeating it would state it twice; a row shows `workload · agent`, and only a
  continuity problem earns a third line.
- **Empty states are invitations.** No Sessions offers the creation action by name;
  a search that found nothing names the query and offers to clear it.

The layer's header is the App's title band, and it is a *page* title: the muted section
label the screen used to open with described the list rather than naming the screen.

## Contextual interaction capsule

A lightweight floating capsule is the primary high-level interaction surface over the Terminal.

Its first responsibility is conversational / intent input. Secondary capability actions should appear only when the user requests them or when the current context gives them a clear reason to exist.

Typical entry mechanisms include:

- the primary input itself;
- a `+` affordance for explicit expansion;
- shortcuts / commands;
- lightweight presence from an active contextual capability, reached through that expansion.

The capsule must not become a permanent toolbar that accumulates every registered feature.

### Capability presence

The resting capsule does not change when a capability becomes available, relevant, or active.

The App uses the disclosure model from [capability-emergence.md](../capability-emergence.md):

```text
Dormant -> Peek -> Workspace
```

`+` remains the explicit Nession capability entry. After the user chooses a capability — from `+`, or from a sensed row leading its list — the App may show a temporary Peek above the capsule.

For example:

```text
Terminal running a shell
    -> neutral capsule

Git becomes relevant
    -> resting capsule remains unchanged
    -> Git may be discovered/selected through `+`
    -> Git Peek: branch / worktree / changes
    -> Open Workspace for full Git
```

Selecting through `+` — or choosing a sensed row that leads its list — lands on
the Peek: choosing a capability is asking to look at it, so the detail is what
the choice opens (`capability-emergence.md` — `+` is "the explicit entry for
*peeking*"). There is no shallower depth behind it any more: the Signal was
removed on 2026-10-04 because it could not be selected into, and nothing shows
a capability on its own. A dismissed Peek returns to dormant, not to a Signal.

The Peek is session-scoped and intentionally shallow. Rich state, history, management, and capability-specific workflows belong in Workspace.

Opening Workspace must preserve the originating Session and capability context. Closing/dismissing returns the user to the same Terminal without rebuilding context.

## The no-Session root

`Sessions ← Terminal → Workspace` describes the model *around work*. Two facts were
unstated, and both showed up as a dead end on a narrow viewport (#1082):

- the App experience is chosen by **viewport**, not by whether work already exists. A
  phone gets the App shell before anything is selected — otherwise the model, the
  Sessions layer, and the top-level gesture are all absent exactly when the user has
  nothing else to navigate with;
- **Workspace is Session-scoped.** It is the depth *around* a piece of work, so with no
  work there is nothing for it to show. It is not hidden or disabled: the layer does not
  exist, and the gesture that would open it has no third position to page to.

The root in that state is a **home**, and `visual-language.md` §Empty states governs it:
an invitation to act, in the interface's voice, using the action's own name. It carries

- a primary **New Session** action, opening the same creation flow as everywhere else —
  and on success the created Session becomes the current work and the App enters its
  Terminal, rather than creating something and leaving the user where they were;
- a visible route to Sessions, plus the same Sessions affordance in the bar;
- no Workspace affordance, and no invented Session identity in the bar.

If creation cannot succeed the action says why, in place. A disabled control with no
explanation is the same dead end one step earlier.

## Gestures and visible alternatives

- Swipe right to reveal/open Sessions; swipe left to reveal/open Workspace.
- **The shell does not claim the gesture on a layer whose depth offers its own
  leave** (#1081). `Sessions ← Terminal → Workspace` describes the model *around*
  work; inside the Workspace it is the pushed depth's business, and
  [one navigation bar per depth](#one-navigation-bar-per-depth) gives that depth
  exactly one leave — the page header's Back. Two routes out of one depth is the
  defect #1051 names, and here it is worse than untidy: the Back is **allowed to
  refuse** (Files' asks before discarding an unsaved editor) and the shell's
  leave is not, so a shell page from there threw the work away. The gesture
  returns at the Workspace root, where Back and the shell both mean the
  Terminal and there is nothing to compete over.
- The gesture spans the shell chrome. **A work surface owns every touch that
  begins in it, except in the shell's edge region** (#1081, #2724). The outer
  `EDGE_PLATFORM_GUARD_PX` (24px) of the shell belongs to the platform's own
  edge gesture; the shell's `EDGE_BAND_PX` (28px) starts *after* that guard.
  Each band owns one direction: the left band pulls Sessions in (a rightward
  drag), the right band pulls Workspace in (a leftward one). A drag from an
  edge band that moves the other way is surrendered back to the surface.
- The exclusion is what makes the band necessary, and also what keeps it small.
  A surface keeps the touches that begin in it because a page that started there
  would spend the surface's first horizontal pixels — an xterm selection, a
  CodeMirror selection, a capsule drag — before the surface ever saw them
  (#1049). On the Terminal screen the viewport and the capsule *are* the screen,
  so applying that to the edges as well left the gesture with almost no
  reachable start: the product said `Sessions ← Terminal → Workspace` was
  spatial while the place a user actually swipes returned before the gesture
  began. The band restores a reachable start; it does not give back the
  surface's interior, and it takes nothing from the shell chrome, where the
  gesture keeps its whole width.
- The guard is a **physical-device finding**, not a width increase. On
  2026-11-05 an iPhone Safari test showed that a band starting at the screen
  edge loses the leftward back-swipe contest to the OS: Safari recognises the
  gesture before the page receives a cancelable move. The shell therefore
  starts its 28px band after a 24px platform guard instead of competing for the
  same pixels. The guard and band are still hypotheses — SC-07 must confirm
  them on the actual device and the visible Sessions/Workspace controls remain
  the fallback. A start inside the guard is not shell navigation, and neither
  the shell pager nor the Terminal direction pad may claim it.
- **Inside the Terminal, a stationary long-press is the terminal's own input
  gesture** (#2657). After roughly 380 ms the viewport shows a small translucent
  direction dial; dragging along an axis sends that semantic arrow key, and
  holding repeats at 1/2/4/8 keys per second, farther from the centre being
  faster. Returning to the centre or releasing stops it. Before the hold ends
  nothing is consumed, so a tap, a quick swipe and scrolling behave as before,
  and the gesture never starts inside the platform guard plus the shell's
  `EDGE_BAND_PX` — that edge region stays navigation's. The dial is an
  accelerator, not a persistent control; Terminal Keys remain the visible,
  accessible fallback. The terminal-owned contract (ownership, key encoding,
  cancellation) is in
  [interaction-semantics.md](../terminal/interaction-semantics.md#touch-direction-pad-2657).
- Gestures are accelerators, not the only discoverable or accessible path.
- Sessions and Workspace must also have visible controls, but those controls should remain visually quiet when they are not the user's current intent.

### Swipe contact ownership and feedback (#2724)

The edge band says *where* a page may begin. #2724 owns what happens to the
contact after that, and the answer is: much less until release.

- **A touch is not navigation at `touchstart`.** It is a candidate. Ownership is
  decided only after `SWIPE_SLOP_PX` (12px) of movement, and a vertical drag is
  content's for the rest of that contact — a later horizontal move cannot revive
  it. A second finger, a genuine `touchcancel`, the browser committing the touch
  to native scrolling, or another surface claiming the finger all cancel.
- **One physical contact, one owner.** Touch Events own it by
  `Touch.identifier` from start to end. Touch-generated `pointercancel` /
  `lostpointercapture` are not its end; Pointer Events are only a desktop
  rehearsal path. The Terminal's long-press direction pad (#2657) claims the
  identifier through the shared registry; once claimed, the shell stands down
  immediately rather than waiting for events the pad now consumes.
- **A claimed destination is frozen.** Crossing back over the origin clamps the
  preview to zero instead of settling; only release decides commit or snapback.
  A reversal followed by forward travel may still commit the same destination.
- **Release decides.** Commit at `max(64px, 18% of the shell width)`, or on a
  purposeful flick of at least 40px at 0.45 px/ms or faster; speed alone cannot
  commit a shorter travel. With no destination at all (the end of the pager, or
  no Workspace before a Session) the preview is damped rather than claimed.
- **Feedback exists only while the drag is live.** The adjacent layer reveals
  progressively under the finger with a subtle shadow, and a transient label
  names the frozen destination with its direction. There is no resting swipe
  tutorial, edge rail or navigation overlay; release removes the label. The
  no-Session root names its index-1 destination **Home**, never a fake Terminal.
- **Interactive owners outrank the band.** A button, input, open alert dialog,
  an expanded Capsule Peek, a nested horizontal scroller (including the
  capability row) or an active text selection keeps its touch even at the
  shell edge: claiming there would spend the first pixels of the action the
  user aimed at. A pushed Workspace detail continues to own its own leave.
- **Reduced motion is an instant decision.** The settle animation collapses to
  the same commit/snapback state change. Opening, cancelling or completing a
  layer never remounts xterm, changes PTY/tmux dimensions, resets scrollback,
  clears the composer or drops Workspace context.
- **Numbers are hypotheses until SC-07.** The values above come from the
  approved mobile prototype
  ([shared `prototype` branch](https://github.com/BestNathan/nession/tree/prototype/mobile-swipe-2724)),
  plus the 2026-11-05 iPhone Safari finding that the outer edge belongs to the
  OS. The guard, band, thresholds and velocity are initial exploration values;
  a physical Safari/PWA lane must confirm the platform's own edge ownership and
  settle the final numbers before they are treated as measured.

The exact header/button implementation may evolve. The invariant is the spatial relationship and the existence of a visible alternative to gestures.

## Workspace inside App

Workspace is contextual depth around the logical work, not a tool lobby.

Its visible content should be driven by resources, locations, and capability state. Unavailable capabilities do not need disabled permanent slots simply because an extension exists.

Workspace capabilities may use native push/pop navigation internally for deeper details. Nested navigation must not conflict with the top-level `Sessions ← Terminal → Workspace` gestures.

Files may push an editor; Claude Code may open configuration/history; Git may expose repository state. These are capability-internal flows, not a requirement for one shared master/detail shell.

### App Files navigator (#1140)

Desktop/Web Files stay a tree; App Files are a **navigator** — one directory per screen,
push/pop for folders, full-screen read-first viewer for files. Shared headless
filesystem logic; presentation is App-owned (`FilesAppLayout`, not `FileBrowser`).

```text
Files root  →  tap folder  →  child directory  →  Back restores list + scroll
                           →  tap file       →  viewer (shell push)
```

The shell page header names only the current directory or file; the full path is a
horizontal breadcrumb under it with search and folder-action entries. **Search** is a
pushed depth: fuzzy filename/path match over a bounded `listDir` walk, results open the
same viewer, and Back restores the saved directory stack. **Folder actions** (⋯) open a
bottom sheet over the current list — refresh, copy workspace-relative path, copy full
path — without a shell push.

**v1 shipped** with navigator, search, folder sheet, viewer push, scroll restoration,
terminal `path:line` deep-link (#1175), and long-press selection mode (#1174).
Richer viewer/sheet actions may still extend this model without reintroducing an
expandable tree on App.

### One navigation bar per depth

Workspace is a stack of depths, and **at any moment exactly one navigation bar owns the
depth on screen**:

```text
Terminal
  ↓
Workspace capability root
  ↓
capability internal push
  ↓
deeper detail
```

Each transition has one predictable back path: from a capability root, Back goes to the
Terminal; from a pushed detail, Back goes to the capability root it was pushed from.

What this rules out is the composition the App shipped with — a page header, a
capability's own push sub-header and the file viewer's close bar rendered as three
independent rows, each answering "what page am I on?" and "what does Back mean?" for
itself. It is the *level*, not the component, that owns navigation.

- **The App shell owns the bar; a capability owns its content and its local actions.**
  A capability declares that it has pushed a depth and what leaving it means; it does
  not render a competing bar. File actions such as Edit and Save belong to the editor
  whose state they act on and may sit in a subordinate toolbar.
- **One leave per depth.** Two controls with the same meaning — a Back and a ✕ both
  ending the same view — are the defect, not a convenience.
- **A guard travels with the state it protects.** Leaving a modified editor must still
  ask before discarding; the capability supplies that guard, so the shell does not have
  to know an editor exists to honour it.
- **Session identity belongs to the Terminal.** It is the depth the Workspace was
  opened from, and it is what the user returns to — not chrome to restate on every
  Workspace screen.

See `#1051` and [workspace.md](../workspace.md). The App presentation of this rule —
including where the capability switcher may appear — is in
[workspace-navigation.md](../design-system/patterns/workspace-navigation.md).

See [workspace.md](../workspace.md).

## Current capability-state mapping

The generic capability lifecycle is:

```text
unavailable -> available -> relevant -> active
```

App presentation should normally map it as follows:

- `unavailable`: no presence;
- `available`: optionally discoverable in Workspace / explicit expansion;
- `relevant`: contextual Workspace or capsule affordance may appear;
- `active`: may be marked/discoverable in `+`, and may project a temporary Peek once the user chooses it, without changing the resting capsule.

Exact detection is implementation-specific.

## Device and viewport coverage

The executable matrix is [`design/contracts/viewports.json`](../../../design/contracts/viewports.json) — the single source that the browser contract suite iterates. For App it currently pins portrait at 375 / 390 / 430 and landscape at 844×390.

**Two scenarios are not covered, and are recorded here as limitations rather than left silently unchecked** (#1049):

- **Safe area.** Every consumer of `env(safe-area-inset-*)` in the web client uses `-top` or `-bottom`; `-left` and `-right` appear nowhere. That is adequate in portrait, where the notches and the home indicator are top and bottom — but landscape is exactly the case where those insets move to the **sides**, and nothing accounts for that. No fixture sets a non-zero inset, and Playwright cannot synthesise `env()` values without a real device.
- **Software keyboard.** Opening an IME changes the visual viewport, and the capsule is meant to stay docked above it. No test exercises this: jsdom has no keyboard, and the Playwright fixtures run without one. Resizing the viewport in a test is *not* a substitute — it emulates a smaller viewport, not an IME appearing over one.

Closing either needs a real device or emulator. Until then this is a **known evidence gap, not a known defect**: nothing here says the App breaks under an IME or a landscape inset, only that no test would notice if it did.

## What App must not do

- Ship as a responsive/shrunken Web dashboard.
- Make gestures the only way to reach Sessions or Workspace.
- Turn Workspace into a permanently visible catalog of installed extensions.
- Turn the terminal capsule into a feature toolbar.
- Force every capability to expose its full UI at first contact.
- Let an extension invent its own global navigation or visual language.
- Collapse Agent/location connectivity, Session lifecycle, and attachment into one status.

## Implementation boundary

The implementation does not need to literally maintain three permanently translated pages. Sessions may be a drawer/layer, Terminal the root content, Workspace a contextual layer, and capability details overlays or pushed views.

The App ships this way (#1049): the Terminal is the root and Sessions and Workspace are
layers over it, so opening either one does not unmount the work surface.

The product requirements are:

1. current work remains dominant;
2. the spatial model remains coherent;
3. capability presence follows context;
4. deeper complexity is explicitly opened;
5. visible non-gesture controls remain available;
6. the implementation stays subordinate to [`VISION.md`](../../../VISION.md) and [`PRINCIPLE.md`](../../../PRINCIPLE.md).