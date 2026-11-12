# SessionItem

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [product model](../../product-model.md) → [information architecture](../../information-architecture.md)

SessionItem represents one Session in Session navigation. It helps the user recognize and return to work without making infrastructure or tool identity the primary object.

## Purpose

Answer, at a glance:

- which work/session is this;
- what kind of workload is happening there, when useful;
- where it is running, when that helps distinguish it;
- how recent it is;
- whether a reachability/lifecycle issue needs attention.

The Session's **display identity** is the primary identity: its user-authored
metadata title when one is set, otherwise its tmux name. A title is a display
alias — it never renames tmux, changes `session_id`, or alters attach/kill
targets (#2789).

## Contextual anatomy

```text
Terminal reconnect reliability
Claude Code · devbox-01 · 2m
```

(`Terminal reconnect reliability` is the Session's metadata title; a Session
without one shows `fix-terminal-reconnect`, its tmux name.)

Possible parts:

| Part | Role |
|------|------|
| Session display title | Primary work identity: metadata title, else tmux name |
| Workload hint | Optional hint such as Claude Code, Codex, zsh; never an IA type |
| Location / Agent hint | Optional execution-context metadata when useful for disambiguation |
| Recency | Optional last-activity signal |
| Selection | Shows the active Session |
| Degraded state | Local, explicit signal only when continuity is affected |
| Secondary actions | One anchored `···` menu: Session details, Edit details, Attach settings, Kill session |

Tags and descriptions belong to the Session's Workspace details, not to its
navigation row: a row states what the work is, not its full description or a
tag cloud (#2789). The display title changes the row's copy, never its
structure, workload/Agent/recency slots or degraded-state semantics.

Do not force every row to show every metadata fragment. If six rows are all on the same healthy Location, repeating the Agent name six times may add no value.

**Recency is the one fragment a list may take away from every row at once.** When
the list is grouped by time, the group label states when those rows happened, and
a row that repeated it would state the same fact twice ([session-list.md](session-list.md)
§History grouping). The slot is then absent whole — its separator with it, so the
line reads `{workload} · {agent}` rather than trailing off.

## Metadata priority

Apply the principle "show only what matters now":

1. Session identity is always the strongest signal.
2. Workload/location/recency are supporting hints and may be omitted when redundant.
3. Degraded reachability or lifecycle state may temporarily outrank routine metadata.
4. Destructive actions stay hidden until hover/focus/selection/explicit overflow.

## Workload semantics

A workload hint can be inferred from foreground process or integration state, but it is not a permanent Session type.

```text
shell
Claude Code
Codex
OpenCode
vim
other TUI / process
unknown
```

An active coding-agent capability may gain contextual presence elsewhere in the Session. The SessionItem only needs enough hint to help recognition; it should not become a mini capability dashboard.

## Location / Agent semantics

Long term, execution context belongs to Workspace Location/provider semantics. Today Agent identity is a common source.

The row should therefore conceptually present **where this work is running**, not imply that Agent is the parent of the Session.

Location/Agent metadata may be:

- shown when Sessions span different machines/environments;
- shown when a connectivity problem affects this Session;
- hidden when redundant;
- replaced by a more user-meaningful Workspace Location label as the product model evolves.

## Independent state dimensions

Do not collapse infrastructure connectivity, Session lifecycle, and this-client attachment into one colored dot.

### Infrastructure / location reachability

| State | Presentation |
|-------|--------------|
| Healthy | Usually quiet or omitted |
| Connecting / reconnecting | Short contextual phrase when it affects entry |
| Offline / error | Explicit local signal such as `Agent unreachable` / `Location unreachable` |

### Session lifecycle

| State | Presentation |
|-------|--------------|
| `active` | Normal Session identity |
| `exited` | Secondary treatment; row can remain if useful/history allows |
| `unknown` | Neutral; do not invent failure |

### This-client attachment

Attachment is usually not useful on every inactive row. Show it only where it clarifies current state, such as attach-in-progress or attach failure.

An Agent being offline does not prove the Session exited. A detached client does not prove the Session stopped.

## Visual contract

### Dominance

- Session name is the only normal high-emphasis text.
- Supporting metadata shares a quieter band.
- One degraded fact may gain local emphasis without turning the whole row into an alarm card.

### Density

Rows should remain highly scannable. Prefer two concise lines over multiple badges, chips, and icons.

Web can use compact navigation density; App must preserve touch targets without inflating every metadata element.

The App's floor belongs to the row's **controls**, not to the row's box. The row measures taller than its primary control — the `…` trigger beside it is what sets the App row's height — so a row measuring 374×60 is compatible with a 36px control inside it, and did contain one (#1066). The primary select control and every action control take the experience's control band (`control.sm`: 44px on App, where it equals `control.md`; 28px on Web, where the control is already taller and a pointer needs no floor). `expectTouchTargetsWithin` is the assertion that enumerates them; the pattern's own `touchTargetToken` covers the row box and cannot.

### Surface treatment

- Flat list rows, not nested cards.
- Selection uses one coherent cue.
- Healthy state needs no green success badge.
- Per-capability branding should not color the row.

## Progressive disclosure

Secondary actions and technical detail should not occupy permanent row width.
Web rows reveal one anchored `···` trigger on hover/focus/selection; narrow Web
and every App row keep the same trigger visible with a 44px touch target. Both
experiences expose the same four task-level actions and the same floating
overlay, separate from row selection:

```text
Session details     read the target Session without selecting it
Edit details        edit title / description / tags through the existing metadata owner
Attach settings     the existing configure dialog
──────────────
Kill session        destructive, separated from the three non-destructive actions
```

The menu dismisses on Escape, outside click, or scroll of the **owning list**
(the Web sidebar viewport or the App Sessions layer's own viewport — never a
single global container). Viewing details never moves the current Session, and
the App keeps the Terminal mounted underneath the Sessions layer while details
or settings are open. Editing changes only the display alias, not the tmux name
or `session_id`; an offline Agent keeps details readable while editing is
explicitly unavailable. Kill reuses the existing typed exact-tmux-name
confirmation, where the display title is not accepted.

## Tokens

| Part | Tokens |
|------|--------|
| Session name | Semantic `text.primary` |
| Metadata | Semantic `text.secondary` / `text.tertiary` |
| Selection | Semantic accent/surface |
| Infrastructure failure | current `agent.*` Domain state where Agent-backed |
| Session lifecycle | `session.*` |
| Attachment | `attachment.*` when shown |
| Row density | Experience `row.*` / App touch-target tokens |

Do not use Primitive palette colors directly.

## Web vs App

The semantic hierarchy remains the same.

| | Web | App |
|--|-----|-----|
| Density | Compact, scan-oriented | Touch-safe, still concise |
| Secondary actions | Hover/focus/overflow | Overflow/swipe/context action |
| Metadata | May fit one secondary line | May truncate/reduce before adding vertical chrome |
| Session navigation | Often list/sidebar/drawer depending current Web composition | Spatial Sessions layer |

## Anti-patterns

- Agent as a section header/navigation parent for every Session.
- Equal visual weight for Session name, Agent, workload, recency, and status.
- Always showing healthy Agent/location metadata even when redundant.
- One chromatic dot representing Agent + Session + attachment.
- `Session offline` when only infrastructure reachability is known to have failed.
- Permanent destructive controls.
- Extension-specific badges accumulating until the row becomes a plugin strip.
- Treating `Claude Code`, `Codex`, etc. as permanent Session types that redefine navigation.

## Acceptance for future implementation work

- [ ] Session identity remains the primary row signal, using the metadata
  title when set and the tmux name otherwise.
- [ ] Workload and execution context are optional supporting metadata, not navigation parents.
- [ ] Redundant healthy metadata can disappear.
- [ ] Degraded infrastructure/lifecycle/attachment states remain semantically distinct.
- [ ] Capability growth does not cause proportional badge growth in Session rows.
- [ ] Destructive/secondary actions use progressive disclosure.
- [ ] The pattern can evolve from Agent labels toward Workspace Location/provider labels without changing its product role.
