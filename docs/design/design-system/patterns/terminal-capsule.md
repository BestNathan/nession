# TerminalCapsule

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [product model](../../product-model.md) → [interaction](../../interaction/)

The TerminalCapsule is Nession's lightweight contextual interaction surface over the active Session's Terminal.

It is designed to let the user express intent without turning the Terminal into a dashboard. The capsule is conversational first, extensible second, and always subordinate to the work happening in the Terminal.

> **Decision update (2026-09-19): #748 still governs the resting capsule, but no longer defines the whole capability surface.**
> The resting capsule remains identical across capability states: no permanent capability chips or one-button-per-extension chrome.
> The `+` expansion remains the explicit Nession capability entry. However, once a capability is selected, triggered, or earns
> contextual presence, Nession may materialize a temporary **Signal** or **Peek** adjacent to the capsule. Rich/full capability
> state then deepens into Workspace.
>
> The stable rule is:
>
> **Resting capsule stays minimal. Capability state may progressively emerge around it, then deepen into Workspace.**
>
> See [progressive capability disclosure](../../capability-emergence.md).

> **Contract:** `design/contracts/patterns/terminal-capsule.json` — measurable layout rules ([contracts.md](../contracts.md)).

## Purpose

The capsule provides one quiet place for high-level interaction with the current Session:

- conversational / natural-language intent;
- direct terminal input where appropriate;
- commands and shortcuts;
- explicit `+` expansion as the Nession capability entry;
- lightweight capability Signal/Peek surfaces that may emerge after selection or contextual relevance;
- context-preserving deepening from Terminal into Workspace for full capability state.

The capsule is **not** a permanent toolbar or a feature catalog. A registered capability does not receive a button simply because it exists.

## Product rule

The capsule implements three root Principles directly:

1. **Show only what matters now.** The resting state stays minimal — and identical across capability states.
2. **Let capabilities emerge from context.** Relevant/active capabilities may be discovered through `+`, then project only the amount of state justified by the current work.
3. **Prefer progressive disclosure.** The first layer shows intent; Signal and Peek remain lightweight; full capability interaction belongs in Workspace.

## Anatomy

```text
┌─ Terminal well ─────────────────────────────────────────────┐
│  xterm / current workload                                   │
│                                                            │
│        ┌─ TerminalCapsule ───────────────────────────┐      │
│        │ [+] [ input ... ]                        [send] │      │
│        └─────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────┘
```

The exact ordering is experience-specific. The semantic regions are:

| Part | Role |
|------|------|
| Capsule shell | Quiet floating surface anchored to the current Session |
| Primary input | Conversational / intent input; the main interaction |
| `+` / expansion affordance | Explicit entry to Nession capabilities. It keeps the resting capsule stable while allowing the reachable/relevant capability set to grow without one permanent button per extension |
| Capability Signal | Minimal current-state projection that explains why a capability matters now; temporary and subordinate to Terminal |
| Capability Peek | Small Session-scoped summary opened from a Signal or capability entry; intentionally incomplete and usually offers a path into Workspace |
| Primary action | Send / execute current intent |
| Terminal-local accessory | Contextual Terminal-only interaction such as Terminal Keys; does not imply a Workspace view |

## Contextual capability presence

Capabilities follow the lifecycle defined in [product-model.md](../../product-model.md):

```text
unavailable -> available -> relevant -> active
```

Lifecycle is separate from disclosure depth:

```text
Dormant -> Signal -> Peek -> Workspace
```

See [capability-emergence.md](../../capability-emergence.md).

The resting capsule is identical across lifecycle states. A capability may change what `+` contains, but the capsule does not grow permanent capability chrome.

Typical progression:

| Depth | TerminalCapsule behavior |
|-------|--------------------------|
| Dormant | No capability surface |
| Signal | Small read-only/current-state projection adjacent to the capsule |
| Peek | Compact Session-scoped summary with a clear path deeper |
| Workspace | Full capability surface; outside the capsule |

The capsule should not render a row of installed extensions.

### Example: Git

```text
Git available
  -> neutral resting capsule

user opens + and selects Git
  -> compact Signal: feature/capsule · worktree capsule · 3 changed

user asks for more
  -> Peek: branch/worktree, staged/unstaged, ahead/behind, short changed-file summary

Open Workspace
  -> full Git surface: diff, staging, commit history, branches, worktrees
```

The same model must remain generic enough for Claude Code, Codex, OpenCode, debugging, databases, Kubernetes, and other contextual capabilities.

## Progressive disclosure

The capsule participates in, but does not own, the complete capability UI.

```text
resting capsule
    ↓ + / context
capability entry
    ↓ select / contextual emergence
Signal
    ↓ ask for more
Peek
    ↓ Open Workspace
full capability surface
```

Signal/Peek should answer what matters **now**. Full history, management, configuration, large diffs, graphs, forms, and complex multi-step workflows belong in Workspace.

A Terminal-local capability such as Terminal Keys may stop at an interactive accessory and have no Workspace projection.

## Input modes

The current implementation may support terminal-oriented modes such as direct input, command/physical-key controls, history, paste, copy, and send.

Those modes are implementation tools beneath the product interaction model. They must not prevent the capsule from evolving into the shared conversational/contextual entry surface described here.

> **Decision update (2026-09-25): App's `input | commands` toggle was retired by `#1034`.**
>
> It was one of the implementation tools this section permits and [§Implementation migration](#implementation-migration)
> explicitly authorises converging, so retiring it changes none of the product model above — the
> terminal-oriented modes stay reachable and the composer stays the entry surface. What it corrects is
> **where** they are reached from.
>
> A mode *replaced* the composer. The model in this document, in [§Progressive disclosure](#progressive-disclosure),
> and in [capability-emergence.md](../../capability-emergence.md) is the opposite: the composer persists and
> secondary tools emerge around it. App's commands mode was a second, competing terminal-key surface that
> swapped the composer out; Terminal Keys, which `#826` had already made a projection above a surviving
> composer, is the surface that belongs. The mode is gone and the toggle with it.
>
> App also drops its permanent paste and copy controls — [§Anti-patterns](#anti-patterns) already lists
> duplicating native copy/paste as a violation, and the platform supplies both natively. Web keeps the one
> composer control that was never part of any of this: its history trigger. What is left on both
> experiences is the resting anatomy [§Anatomy](#anatomy) draws — `+` leading, one primary action
> trailing.
>
> The mode's own key popover went with it. Neither experience had enabled it for some time (its trigger
> and the mode that owned it were the same switch), so what the change removed was not a live surface but
> the last way to reach one — and, in the same pass, the code that would have drawn it. Terminal Keys is
> the surface for those keys and always was.

Preserve established terminal semantics where the user is explicitly sending terminal input:

- Enter sends/executes according to the active input mode;
- Shift+Enter may insert a newline where supported;
- IME composition must not trigger accidental sends;
- history/command popovers close predictably after execution;
- disabled attachment state makes terminal execution controls inert without turning the capsule into an alarm banner.

## Web vs App

Web and App share the same semantic capsule model while presentation may differ.

| | Web | App |
|--|-----|-----|
| Placement | Floating over/inside Terminal well, usually centered with a bounded max width | Floating inset surface respecting safe area and thumb reach |
| Primary interaction | Conversational / intent input | Conversational / intent input |
| Secondary expansion | `+` as capability entry; compact Signal/Peek density | `+` as capability entry; touch-native Signal/Peek |
| Capability presence | Same lifecycle/disclosure semantics | Same lifecycle/disclosure semantics |
| Deeper capability UI | Workspace surface with preserved Session/resource context | Workspace spatial layer/push with preserved Session/resource context |

Do not fork capability semantics by viewport. Experience-specific presentation is allowed; product meaning is shared.

## Visual contract

Derived from [`PRINCIPLE.md`](../../../../PRINCIPLE.md) and [visual-language.md](../../visual-language.md).

### Dominance

- The current work remains visually dominant.
- The capsule is refined and clearly interactive, but it must not outshine Terminal output in the resting state.
- Capability presence is intentionally lightweight. The resting capsule stays neutral; Signal/Peek may emerge temporarily after selection or contextual relevance.

### Quality through precision

The capsule should feel high-quality through:

- exact spacing and alignment;
- stable geometry during state changes;
- careful typography and icon sizing;
- subtle elevation rather than stacked borders;
- predictable motion and focus behavior;
- clear hierarchy between primary input and secondary actions.

Minimal does not mean bare or unfinished.

### Information hierarchy

- **Primary:** user's current intent/input.
- **Secondary:** send/execute and the `+` capability entry.
- **Tertiary:** temporary Signal/Peek projections and Terminal-local accessories.

### Two axes on one control

An icon control in the capsule has a **hit target** and a **drawn affordance**, and
they are two objects rather than two values on one element.

| | What it is | Where it is declared |
|--|-----------|----------------------|
| Hit target | the box that receives the tap | the Experience control band — `category.control`'s `heightToken`, and the touch floor on App |
| Drawn affordance | the circle painted inside that box | `control.visualSize`, named per Experience by `pattern.terminal-capsule`'s `visualSizeToken` |

The axes are split because the two platforms disagree about them. On App the control band
*is* the touch floor, and a hit target may never go below it — correctly — but painting the
whole band makes every secondary icon action read as a primary button, which is what
[§Dominance](#dominance) and [§Information hierarchy](#information-hierarchy) are asking it
not to do. On Web there is no touch floor, so the drawn affordance may fill the control it
sits in and the split is a no-op.

**Two DOM nodes, not one class.** Every geometric assertion in the contract
(`expectTokenHeight`, `expectTouchTarget`) measures the element it is handed, so a smaller
painting inside the same box is only measurable on a second node — a class that named a
smaller band on the *same* element would have shrunk the tap target instead, which is the
opposite of the requirement. The gate fails a control whose painting reached its hit target,
so the split cannot converge back silently. Values live in
`design/tokens/experience/*.json`; this document names the tokens and never their numbers.

### Surface treatment

- Floating-control elevation without decorative border stacks.
- Capsule radius from semantic design tokens.
- Avoid nested cards inside the capsule.
- Motion communicates state changes; it does not celebrate routine actions.

## Anti-patterns

- One permanent button per installed extension.
- A toolbar that keeps growing as Nession gains features.
- Automatically opening a full capability panel because a tool was merely detected.
- Treating `+` as a static feature menu unrelated to the current context.
- Duplicating native copy/paste/selection actions as Nession capabilities.
- Reproducing full Git/Claude/Workspace capability clients inside the Terminal Peek.
- Multiple competing primary actions in the resting capsule.
- Capability-specific colors/layouts that fragment Nession's visual language.
- Large persistent chrome that reduces the Terminal viewport.
- Hard-coding Claude Code semantics into the generic capsule.

## Relationship to Workspace

The capsule and Workspace are complementary:

- **Capsule / Session layer:** what is relevant or happening now.
- **Workspace layer:** broader resources, available/relevant capabilities, locations, configuration, and state for the logical work.

A capability may therefore be discoverable in Workspace before it earns Session-level presence.

When Terminal presence is earned, Nession should deepen through Signal → Peek → Workspace while preserving context.

See [workspace.md](../../workspace.md) and [capability-emergence.md](../../capability-emergence.md).

## Implementation migration

Existing `InputComposer`, `CommandsComposer`, terminal quick keys, and related contracts should be treated as implementation assets to converge rather than as the permanent product boundary.

Migration should preserve terminal reliability while changing the semantic ownership of the capsule from "terminal quick-input toolbar" to **contextual interaction surface**.

Where existing executable contracts encode assumptions that conflict with this document, update those contracts in a follow-up implementation change rather than weakening the product model.