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
shell may fully tuck away its navigation column; the App has no such concept — no
collapse control, no expand control, no icon-strip rail. Leaving and opening Sessions
belongs to the App's spatial navigation (Session selection and its visible navigation
affordances), not to a width state.

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

### Row actions

Each Session row carries one touch-safe `···` trigger (44px control band) and one
anchored overlay with the same four task-level actions the Web sidebar exposes
(#2875):

```text
Session details     read the target Session without selecting it
Edit details        edit title / description / tags through the existing metadata owner
Attach settings     the existing configure dialog, without attaching
──────────────
Kill session        destructive, separated; requires the exact immutable tmux name
```

Opening the menu or choosing details/settings never selects or attaches another
Session; the Terminal stays mounted under the Sessions layer and the user returns
to the same layer when the dialog closes. The overlay is not a replacement screen
and never becomes a permanent toolbar. It dismisses on outside click, Escape, or a
scroll of the App-owned Session list viewport, then restores focus to the row's
trigger. These actions reuse the canonical owners — `SessionDetailsDialog` and the
metadata store, `AttachDialog` in configure intent, and `KillConfirmDialog` — so
App does not gain a second editor, attach flow, or kill path.

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
- **The shell does not offer a second leave on a pushed Workspace depth; the
  same coordinator operates the capability's inner stack** (#1081, #3971).
  `Sessions ← Terminal → Workspace` describes the model *around* work; inside a
  pushed depth, a claimed contact routes to the capability's own Pop/Forward
  instead of the outer pager. Two routes out of one depth would be the defect
  #1051 names — and here it is worse than untidy: the Back is **allowed to
  refuse** (Files asks before discarding an unsaved editor) and a shell leave is
  not. So the inner gesture runs the capability's guarded action, never a
  parallel discard. At the Workspace root there is no Pop; the same contact
  returns to the Terminal, where Back and the shell mean one thing.
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
- **Host pull-to-refresh (#4602).** A downward vertical drag at the top of a
  host-owned mutable list is a refresh accelerator: after axis lock, release at
  ≥ 64 CSS px of raw travel commits one current-scope read; a shorter drag
  cancels with no request. The host owns the indicator, release, settling and
  cancellation, including a page switch while a read runs. The gesture never
  captures a contact that is not at top, a horizontal pager swipe, a nested
  collection scroller, or the Terminal/editor's own input. It preserves Capsule
  clearance and uses the existing motion/reduced-motion tokens. The settled
  interaction is in prototype `app-pull-refresh-4602`.
- **The manual refresh action is the contract, not the gesture (#4602).** Every
  mutable list has a visible, keyboard- and touch-operable Refresh in its existing
  header or disclosure, available even when the list is healthy, empty or failed.
  For the Sessions layer this supersedes #1083 §6's "no resting refresh" ruling:
  the action lives in the existing header band (not a permanent refresh row), and
  the degraded problem strip keeps its contextual retry. Capabilities contribute
  a refresh callback and state; they never add a second scroll container, page
  header or gesture. Busy is shown only until that refresh's own promise settles;
  repeated taps coalesce; a failure keeps the last known rows and offers retry.

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
- **The preview keeps following a moving finger.** Up to the preferred reveal
  (80% of the shell) the layer tracks the finger one-to-one. Past it the
  preview continues with continuous resistance toward an absolute 92% bound
  instead of going flat, so a still-moving contact never reads as a frozen UI;
  the bound keeps the current layer from fully leaving, and release still
  decides the navigation (#4185). Dragged-through and rejected previews return
  to rest in the same owned animation.
- **Settle is interruptible, never a dead window.** A contact that arrives while
  a return or commit animation is still on screen catches the animation up
  (applying its pending route or in-stack decision) and becomes the live
  candidate; it is not silently dropped for the animation's remainder (#4185).
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
  OS. The guard, band, thresholds, resistance curve and velocity are initial
  exploration values; a physical Safari/PWA lane must confirm the platform's
  own edge ownership and settle the final numbers before they are treated as
  measured. `docs/design/interaction/app.md` is the current contract; the
  linked prototype's pre-#4185 flat-cap motion is historical.

The exact header/button implementation may evolve. The invariant is the spatial relationship and the existence of a visible alternative to gestures.

### Workspace inner stack swipe (#3971)

The outer spatial pager and the Workspace stack are **one** coordinator, not two
listeners competing for a contact. A touch that begins in the active Workspace
depth is resolved in this order:

```text
platform guard → interactive/work-surface owner → Workspace inner stack → outer spatial pager
```

- **Right swipe = Pop one valid depth.** **Left swipe = Forward only when the
  capability recorded a destination by actually leaving it**; otherwise the
  contact yields to a nested horizontal scroller or resists and snaps back. A
  gesture never enters an unknown resource.
- The capability supplies the destination and its guarded action
  (`WorkspaceDepthControl.setForward` / `WorkspacePush.onLeave`), so a dirty
  Files editor asks before a swipe discards it. Back, the optional Stack Sheet
  and the gesture all run the same leave guard.
- The header and content frame follow the finger up to a short preferred reveal
  (125px), then continue under the same bounded continuous resistance to an
  180px limit (#4185); the Capability Capsule keeps its station and the
  Workspace layer stays opaque, so an internal-depth gesture never exposes the
  mounted Terminal underneath. A rejected Pop/Forward still belongs to the
  Workspace frame: its return animates in place, never through the outer
  page-snapback path, and a new contact during that return catches it up.
- Interactive owners (a button, input, open dialog, xterm, CodeMirror, nested
  horizontal scroller or active selection) keep their contact. The outer
  platform guard and shell edge bands keep the ownership they have outside
  Workspace.
- Stack, forward history, pending dialogs and actions invalidate when the
  selected Session/Agent changes; a capability that has been switched away
  cannot retake header or gesture ownership.

### Soft keyboard and visible viewport (#3523)

A soft keyboard changes the **visible** region, not the Terminal's layout height
(composition §15 owns the four-level contract). In the App:

- Focusing the Capsule composer or the Terminal's mobile IME reveals that
  control just above the visible bottom with a real, bounded outer scroll. The
  Session header stays put, exactly one App header remains, and the work surface
  is **not** shrunk or re-fitted: xterm rows, PTY/tmux size, scrollback and the
  mounted Terminal are unchanged across keyboard open/adjust/close.
- The reveal scrolls only as far as the focused control plus a touch-safe
  margin requires. Composer height changes remain the surface's own measured
  occlusion; the keyboard is never counted as composer or upper-panel clearance.
- While an avoidance range exists, a vertical drag that begins on the Terminal
  moves the **outer page**, not xterm history, and the same delta is not
  dispatched to both owners. At the range's end the next contact returns to the
  Terminal's existing mode-aware history/TUI wheel routing. Horizontal edge
  navigation, terminal selection, the long-press direction pad and multitouch
  keep their own gestures; a tap is never turned into a scroll.
- Leaving the Terminal layer for Sessions or Workspace blurs the covered
  layer's focused control, so a hidden surface cannot keep the keyboard open.
  Opening a dialog moves focus outside the App frame; the dialog owns its own
  focus and the Terminal layer does not invent an avoidance scroll for it.
- The header stays visible while the work surface scrolls. This is the
  implementation's explicit choice from the Requirement's proposed ownership
  tree; the interactive prototype must validate the alternative before final UX
  signoff. The narrowest visible range (landscape + keyboard) still leaves a
  bounded, reversible scroll rather than a clipped dead end.

Chromium + Playwright proves the app-owned geometry, focus and scroll behavior
with a deterministic controlled `visualViewport`/safe-area fixture. It does not
claim native iOS/Android IME animation, which remains outside automated
Acceptance.

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

### App Claude Code workspace (#3829)

Claude Code's App surface follows the same rule from the other side: the
**current conversation is the work**, not one tab among five. The capability
root is the exact bound conversation, read-only; new CLI input stays in the
Terminal. One contextual **Browse** action in the App page header opens the
capability's resource sheet — Conversations and Transcripts under *Work*;
Memory, MCP and Configuration under *Resources & setup*. Choosing an entry
replaces the pushed stack with that resource's root, so Back always returns to
the conversation.

Resource depth is a single push stack under the same host header: collection →
resource → detail (a transcript record, Raw, a memory file, a configuration
file, an MCP tool). Each depth has exactly one Back; covered layers stay mounted
under the one above, so returning restores the list's scroll position and the
reader's place. This is not Web's master/detail scaled down: Configuration is a
single-column list → file, and Memory is a list → file.

The conversation reader is read-only and never renders a composer. Activity is
only the provider's own word (`Running now` / `Finished`); a foreground `claude`
process is not evidence that a turn is working (#2663, #3801). An unbound
Session says so and offers strict-cwd candidates without promoting one to
"current"; an offline Agent says that instead of showing stale history.

### App content surfaces and region hierarchy (#3971)

Workspace has one canvas owned by the host. Inside it, a capability content
region consumes semantic roles instead of laying rows directly on the canvas:

- **Primary surface** — the resource's own region (a Reader, a Collection, a
  Configuration page). One per visible screen unless a genuinely peer region
  exists.
- **Secondary surface** — supporting grouped content inside it (a configuration
  row group, a quiet fact block), only where the relationship warrants it.
- **Section / Group / Row** — a named section; a continuous run of sibling rows
  sharing one separator language; one row with a leading slot, a title/subtitle
  stack and a trailing local action.

Rules:

- whitespace and typography carry separation first, background contrast next,
  borders/radius only when they earn it. **A row is not a card**: rows in one
  group are contiguous and share the group's separator.
- Collection (Git changes, transcripts, files) = grouped rows with section
  labels; Detail (Agent/Image/MCP) = identity + state + grouped facts;
  Configuration (Sandbox/Env) = named editable sections; Reader
  (Conversation/Diff/Raw) = one predominant continuous surface, with no
  card-per-message or card-per-code-block.
- the host owns page scroll and shell geometry; reusable recipes own the
  internal relationships. A capability chooses the role, not the pixels.

### App icon-first actions (#3971)

App chrome and repeated row/toolbar actions use one semantic icon vocabulary:
Back, Browse, Search, More, Create, Edit, Refresh, Filter, Copy, Open, Confirm,
Save and Delete. A capability names the meaning; Nession resolves the glyph and
the 44px App touch target. Icon-only actions always carry an accessible name and
a visible focus state; context menus and destructive confirmations keep **icon +
text**. A narrow Web viewport without the App Experience keeps its Web action
labels.

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

#### Stack header anatomy (#3971)

The one bar carries the depth hierarchy instead of adding a second breadcrumb or
toolbar row:

```text
[Back] | primary title
         secondary path / context | priority icon(s) | More
```

- **Primary title** is the current capability/resource. **Secondary** is the
  immediate ancestry the capability reports, or the active Session/Agent context
  at a capability root. It projects the *actual* stack — never a fabricated
  breadcrumb — and truncates technical identities safely.
- The secondary line is the optional **Stack Sheet** trigger when the capability
  can jump. The sheet lists the real path root-first; choosing an ancestor runs
  the same leave guard as Back, then jumps. A capability supplies the jump and
  the guard; the host owns the sheet.
- Right-side actions are capability-contributed **semantics**. Nession renders
  at most two priority icons and moves every remaining action, and every
  destructive action, into **More** with readable text. Missing actions leave no
  inert placeholder.
- The bar is a compact two-line layout at 375/390/430 and in landscape. The
  Capability Capsule remains present at every depth (the 2026-10-03 owner
  decision in
  [workspace-navigation.md](../design-system/patterns/workspace-navigation.md)).

**Prototype history.** The unified [#3971 prototype record](../design-system/patterns/app-workspace-3971-prototype.md)
supersedes the deep-detail presentation of the #3829 Claude prototype and the
inner-gesture presentation of the #2724 mobile-swipe prototype. Those older
prototype pages carry in-place historical/superseded notices on the orphan
`prototype` branch and remain IA/outer-gesture references only; their
production owners are unchanged. The #4185 motion revision (2026-11-20) updates
both swipe prototypes to the bounded continuous resistance and interruptible
settle above; its pinned source is
`2cb721ccedc54a544749980d32a0167904eb5dbb` on the shared `prototype` branch.

See `#1051`, `#3971` and [workspace.md](../workspace.md). The App presentation of this rule —
including where the capability switcher may appear — is in
[workspace-navigation.md](../design-system/patterns/workspace-navigation.md).

See [workspace.md](../workspace.md).

### Host-owned scrolling and bottom actions (#4115)

The App Workspace host owns the page's vertical scroll and the space at its
end. A capability contributes content; it does not make itself a page scroller,
calculate the Capsule's height, or add trailing padding so its last row can be
seen.

- **One default scroll owner per depth.** The host renders a bounded scrollport
  around an ordinary capability view. The view's content is in natural flow,
  and the scrollport's trailing extent is measured from the scrollport's own
  bottom to the floating bar's top. At rest content may pass behind the
  translucent Capsule Zone; at the end of scrolling the last row or control is
  fully visible and tappable above it.
- **Declared bounded surfaces are the exception.** A collection, reader, diff
  or editor that genuinely scrolls internally declares itself `bounded` on its
  view binding and keeps its internal scroll owners. The host gives it the full
  region; each owner rendered through `WorkspaceBoundedScrollport` carries the
  measured trailing inset on its viewport, while its content spacing stays on
  an inner wrapper (`p-2` cannot override the inset). Split surfaces may have
  several owners at different bottoms — the host measures each from that
  element's own visible rect, not from one shared number.
- **Every route variant is in the coverage contract.** A nested depth, tab or
  section inherits no scrolling guarantee from its parent's `bounded`
  declaration. `scrollCoverage.ts` names the mode and the observable owners for
  every reachable variant, and the design Gate fails closed when a union member
  has no entry.
- **Bottom actions are hosted.** A capability's bottom actions (Files'
  Copy/Delete while selecting) are contributed as content and mounted by the
  host below the scrollport and above the Capsule. The host owns the band's
  safe-area/Capsule inset, so actions stay reachable at every overlay height
  and no capability computes a capability-specific footer offset.
- **No permanently reserved footer.** An actions slot with nothing in it is
  hidden; the scroll end reserves nothing for space that is already outside
  the scrolling viewport. Ordinary notes, errors and status rows live inside
  the scroll area; a genuinely persistent context declares
  `data-workspace-fixed-role="context"` and must stay above the Capsule.
- **The overlay is dynamic.** Opening/collapsing the Capsule, switching
  capabilities or depths, wrapping items, orientation/safe-area changes and a
  keyboard/focus change recompute the same measurement. The App viewport
  environment remains the single keyboard/safe-area reader (#3523); this
  contract consumes its snapshot rather than adding another viewport owner.

Browser proof is Chromium + Playwright against the production fixture. The
Case reads the actual viewport, the designated scroll owner, the last
actionable element and the Capsule rect at `scrollTop = scrollHeight -
clientHeight`, and asserts the element's bottom is no lower than the Capsule's
top (1px rounding tolerance). Source-level ownership is enforced by the
existing layout-ownership Gate, not by a second Gate.

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

## Chromium + Playwright viewport coverage

The executable matrix is [`design/contracts/viewports.json`](../../../design/contracts/viewports.json) — the single source that the browser contract suite iterates. For App it currently pins portrait at 375 / 390 / 430 and landscape at 844×390.

**Two important environment-specific inputs need explicit deterministic Chromium/Playwright fixtures rather than physical-device acceptance** (#1049):

- **Safe area.** The existing browser fixture matrix does not assert a non-zero effective safe-area inset in landscape. Add an explicit Chromium test fixture or test-only CSS-controlled inset input and assert the app-owned layout bounds; this is an application-level invariant, not a claim to reproduce iOS hardware notches or Safari's native `env()` behavior.
- **Software keyboard / visual viewport.** A plain window resize is not equivalent to a real OS keyboard. Use a deterministic Chromium fixture that controls the app-observable visual viewport/keyboard state, then assert keyboard-related layout, focus and scroll behavior. Do not describe this as native iOS IME testing.

**Acceptance policy:** Web and App interaction/visual SCs use Chromium + Playwright at the canonical desktop/mobile viewport matrix; no physical phone, Mobile Safari or installed-App test is required. When a missing fixture prevents an app-owned assertion, record that fixture as the `Pending` prerequisite; lack of native iOS instrumentation alone is not a blocker. Native Safari/OS-specific behavior remains outside the automated acceptance claim, without inventing a Pass for it.

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