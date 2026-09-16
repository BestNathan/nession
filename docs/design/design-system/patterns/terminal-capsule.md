# TerminalCapsule

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [product model](../../product-model.md) → [interaction](../../interaction/)

The TerminalCapsule is Nession's lightweight contextual interaction surface over the active Session's Terminal.

It is designed to let the user express intent without turning the Terminal into a dashboard. The capsule is conversational first, extensible second, and always subordinate to the work happening in the Terminal.

> **Decision (2026-09-16, #748): capability state is expressed inside the `+` expansion, not on the resting capsule.**
> The resting state is identical whether or not a capability is active; the `+` expansion is the single place
> capability presence appears, marking the capabilities that are relevant or active. This **revises** the `active`
> row of the capability table below, which previously permitted presence "directly on or next to the capsule".
> The revision is deliberate, not compliance: the shipped implementation rendered that presence and was
> compliant with the old table. The owner's judgement was that a chip on the resting capsule reads as clutter;
> the capsule's job at rest is intent, and capability state is a secondary question the user asks explicitly.
>
> Five other documents encode the superseded assumption, and all were updated in the same change —
> `interaction/web.md`, `interaction/app.md`, `terminal-surface.md`, `surface-switcher.md`,
> `information-architecture.md`. Leaving any of them would let the next reader cite one to restore the chip.

> **Contract:** `design/contracts/patterns/terminal-capsule.json` — measurable layout rules ([contracts.md](../contracts.md)).

## Purpose

The capsule provides one quiet place for high-level interaction with the current Session:

- conversational / natural-language intent;
- direct terminal input where appropriate;
- commands and shortcuts;
- explicit `+` expansion for secondary actions and for capability state;
- lightweight presence and actions from capabilities that are relevant or active now, expressed through that expansion.

The capsule is **not** a permanent toolbar or a feature catalog. A registered capability does not receive a button simply because it exists.

## Product rule

The capsule implements three root Principles directly:

1. **Show only what matters now.** The resting state stays minimal — and identical across capability states.
2. **Let capabilities emerge from context.** Relevant/active capabilities gain presence in the `+` expansion, which the user opens deliberately.
3. **Prefer progressive disclosure.** The first layer shows intent; presence and deeper controls open explicitly.

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
| `+` / expansion affordance | Explicit entry to secondary contextual capabilities and actions, **and the single place capability state is expressed**. Lists the reachable capabilities and marks the ones that are relevant or active, so one control covers a growing set and the resting capsule never grows with it |
| Capability presence | Identity/state for a capability that has earned relevance or is active, rendered **inside the `+` expansion** as a leading marker plus full-contrast text — never on the resting capsule |
| Primary action | Send / execute current intent |
| Secondary actions | Contextual commands, paste/copy, physical keys, history, and extension-provided actions |

## Contextual capability presence

Capabilities follow the lifecycle defined in [product-model.md](../../product-model.md):

```text
unavailable -> available -> relevant -> active
```

Capsule behavior:

| Capability state | Capsule behavior |
|------------------|------------------|
| `unavailable` | Hidden; not listed in the `+` expansion |
| `available` | Listed in the capsule's `+` expansion, unmarked, without taking a slot on the resting capsule |
| `relevant` | Listed in `+` and marked, and may appear as a contextual action |
| `active` | Listed in `+` and marked with its lightweight identity/state; may expose deeper state on request |

The resting capsule is byte-for-byte the same in all four states. Capability state changes only what the `+`
expansion contains.

The capsule should not render a row of installed extensions.

### Example: Claude Code

```text
Shell only
  -> neutral capsule

Claude Code becomes active in this Session
  -> the resting capsule is unchanged
  -> `+` now marks Claude Code and exposes its actions for this Session
  -> tapping that entry may open a deeper Session-scoped capability surface
  -> closing the surface returns to the same Terminal
```

Claude Code is a reference integration. The pattern must remain generic enough for Codex, OpenCode, Git, debugging, databases, Kubernetes, and other contextual capabilities.

## Progressive disclosure

The capsule should reveal complexity in layers:

```text
resting capsule
    ↓ user types
intent
    ↓ explicit + / capability action
contextual action surface, with marked capability state
    ↓ explicit deeper request
capability-specific panel / overlay / pushed view
```

Deeper configuration, long history, complex forms, and full capability UIs do not belong permanently inside the capsule.

## Input modes

The current implementation may support terminal-oriented modes such as direct input, command/physical-key controls, history, paste, copy, and send.

Those modes are implementation tools beneath the product interaction model. They must not prevent the capsule from evolving into the shared conversational/contextual entry surface described here.

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
| Secondary expansion | `+`, keyboard/command entry, contextual actions | `+`, touch actions, command/physical-key mode as needed |
| Capability presence | Same semantic state | Same semantic state |
| Deeper capability UI | Overlay, panel, popover, or contextual surface chosen by Nession | Overlay, sheet, or pushed surface chosen by Nession |

Do not fork capability semantics by viewport. Experience-specific presentation is allowed; product meaning is shared.

## Visual contract

Derived from [`PRINCIPLE.md`](../../../../PRINCIPLE.md) and [visual-language.md](../../visual-language.md).

### Dominance

- The current work remains visually dominant.
- The capsule is refined and clearly interactive, but it must not outshine Terminal output in the resting state.
- Active capability presence is intentionally lightweight and lives behind `+` until the user asks for more.

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
- **Secondary:** send/execute, and the `+` expansion through which an active capability's presence is reached.
- **Tertiary:** history, copy/paste, commands, shortcuts, and other actions revealed contextually.

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
- Multiple competing primary actions in the resting capsule.
- Capability-specific colors/layouts that fragment Nession's visual language.
- Large persistent chrome that reduces the Terminal viewport.
- Hard-coding Claude Code semantics into the generic capsule.

## Relationship to Workspace

The capsule and Workspace are complementary:

- **Capsule / Session layer:** what is relevant or happening now.
- **Workspace layer:** broader resources, available/relevant capabilities, locations, configuration, and state for the logical work.

A capability may therefore be discoverable in Workspace before it earns Session-level presence.

See [workspace.md](../../workspace.md).

## Implementation migration

Existing `InputComposer`, `CommandsComposer`, terminal quick keys, and related contracts should be treated as implementation assets to converge rather than as the permanent product boundary.

Migration should preserve terminal reliability while changing the semantic ownership of the capsule from "terminal quick-input toolbar" to **contextual interaction surface**.

Where existing executable contracts encode assumptions that conflict with this document, update those contracts in a follow-up implementation change rather than weakening the product model.
