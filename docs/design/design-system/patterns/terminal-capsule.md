# TerminalCapsule

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [product model](../../product-model.md) → [interaction](../../interaction/)

The TerminalCapsule is Nession's lightweight contextual interaction surface over the active Session's Terminal.

It is designed to let the user express intent without turning the Terminal into a dashboard. The capsule is conversational first, extensible second, and always subordinate to the work happening in the Terminal.

> **Contract:** `design/contracts/patterns/terminal-capsule.json` — measurable layout rules ([contracts.md](../contracts.md)).

## Purpose

The capsule provides one quiet place for high-level interaction with the current Session:

- conversational / natural-language intent;
- direct terminal input where appropriate;
- commands and shortcuts;
- explicit `+` expansion for secondary actions;
- lightweight presence and actions from capabilities that are relevant or active now.

The capsule is **not** a permanent toolbar or a feature catalog. A registered capability does not receive a button simply because it exists.

## Product rule

The capsule implements three root Principles directly:

1. **Show only what matters now.** The resting state stays minimal.
2. **Let capabilities emerge from context.** Relevant/active capabilities may gain presence.
3. **Prefer progressive disclosure.** The first layer shows intent and presence; deeper controls open explicitly.

## Anatomy

```text
┌─ Terminal well ─────────────────────────────────────────────┐
│  xterm / current workload                                   │
│                                                            │
│        ┌─ TerminalCapsule ───────────────────────────┐      │
│        │ [+] [capability presence?] [ input ... ] [send] │      │
│        └─────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────┘
```

The exact ordering is experience-specific. The semantic regions are:

| Part | Role |
|------|------|
| Capsule shell | Quiet floating surface anchored to the current Session |
| Primary input | Conversational / intent input; the main interaction |
| `+` / expansion affordance | Explicit entry to secondary contextual capabilities and actions |
| Capability presence | Optional identity/state for a capability that has earned relevance or is active |
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
| `unavailable` | No presence |
| `available` | Normally no resting presence; may be discoverable after explicit `+` expansion when useful |
| `relevant` | May appear as a contextual action or lightweight hint |
| `active` | May gain lightweight identity/state directly on or next to the capsule |

The capsule should not render a row of installed extensions.

### Example: Claude Code

```text
Shell only
  -> neutral capsule

Claude Code becomes active in this Session
  -> Claude Code presence appears subtly
  -> `+` exposes Claude Code actions relevant to this Session
  -> tapping presence/action may open a deeper Session-scoped capability surface
  -> closing the surface returns to the same Terminal
```

Claude Code is a reference integration. The pattern must remain generic enough for Codex, OpenCode, Git, debugging, databases, Kubernetes, and other contextual capabilities.

## Progressive disclosure

The capsule should reveal complexity in layers:

```text
resting capsule
    ↓ user types / capability becomes relevant
intent + lightweight presence
    ↓ explicit + / capability action
contextual action surface
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
- Active capability presence is intentionally lightweight until the user asks for more.

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
- **Secondary:** send/execute and an active capability's lightweight presence.
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
