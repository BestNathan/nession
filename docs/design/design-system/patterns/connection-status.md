# ConnectionStatus

Atom for **independent** presentation of the three domain dimensions. Other patterns compose it; they must not invent a fused “session.running / session.failed” light.

## Purpose

Make Agent connection, Session lifecycle, and this-client attachment readable as three facts ([product-model.md](../../product-model.md), [tokens.md](../tokens.md)).

Used compactly in [SessionHeader](session-header.md) / [AgentContext](agent-context.md) neighbors, and more explicitly in [AgentDetail](agent-detail.md). [SessionItem](session-item.md) may use a reduced form for reachability.

## Anatomy

Three **channels**. Compact header form may show one line with three labeled fragments; detail form may stack them.

```text
Compact:

  Agent  online    Session  active    Attached

Detail:

  Agent connection    online
  Session             active
  This client         attached
```

| Channel | Dimension | Allowed values |
|---------|-----------|----------------|
| Agent | Agent connection | `online` `connecting` `reconnecting` `offline` `error` |
| Session | Session lifecycle | `active` `exited` `unknown` |
| Attachment | This client | `attached` `attaching` `detached` `failed` |

Each channel has a label (or accessible name) so a color-only encoding is not the only signal.

## States

### Canonical example (normative)

Agent `offline`, Session last-known `active`, attachment `detached` or `failed`:

| Channel | Value | UI |
|---------|-------|-----|
| Agent | `offline` | Prominent; “Agent offline” / “Agent unreachable” |
| Session | `active` or `unknown` | Neutral; **not** painted as failed |
| Attachment | `detached` / `failed` | “Not attached” / “Attach failed” — not “Session offline” |

The user must be able to tell this is an **Agent connectivity** problem.

### Other combinations (illustrative)

| Agent | Session | Attachment | Reading |
|-------|---------|------------|---------|
| `online` | `active` | `attached` | Healthy working state; Agent channel quiet |
| `online` | `active` | `detached` | Session exists; this client is not in it |
| `online` | `exited` | `detached` | Session ended; Agent is fine |
| `online` | `active` | `attaching` | Attach in flight; do not reuse Agent `connecting` chrome |
| `reconnecting` | `active` | `attached` | Keep Session+attachment; Agent channel prominent |
| `error` | `unknown` | `failed` | All three visible; still three labels |

## Tokens

| Channel | Domain tokens |
|---------|-----------------|
| Agent | `agent.online` `agent.connecting` `agent.reconnecting` `agent.offline` `agent.error` |
| Session | `session.active` `session.exited` `session.unknown` |
| Attachment | `attachment.attached` `attachment.attaching` `attachment.detached` `attachment.failed` |

Labels: Semantic `text.secondary`. Values: corresponding Domain token (and Semantic `success` / `warning` / `danger` only as the Semantic parent of those Domain tokens, never a Primitive class in product TSX).

**Forbidden:** one `bg-green-500` / `bg-gray-400` dot for the whole widget.

## Web vs App

Same three channels and copy rules.

| | Web | App |
|--|-----|-----|
| Compact | Header-scale | Header-scale with `touchTarget` if tappable to expand |
| Detail | AgentDetail section | AgentDetail section |
| Color + text | Both required | Both required (gestures do not replace status text) |

## Visual Contract

Derived from [visual-language.md](../../visual-language.md) and canonical Active Terminal / App fixtures ([#563](https://github.com/BestNathan/nession/pull/563), [#568](https://github.com/BestNathan/nession/pull/568)).

### Dominance

- In compact header form, ConnectionStatus is **quieter than the Session title** and must not compete with the Terminal surface below.
- No channel dominates until its domain condition is degraded.

### Information hierarchy

- Three **labeled** channels: Agent connection, Session lifecycle, this-client attachment.
- Labels at `tertiary`; values at `secondary` when healthy, `conditional-prominent` when that channel alone is degraded.
- Compact form may collapse to one metadata line; detail form (AgentDetail) stacks channels with equal structure.

### Alignment

- Compact: horizontal fragments with consistent label→value rhythm; baseline-aligned in header.
- Detail: label column + value column; left-aligned.

### Density

- **Metadata / status density** — smallest readable chrome text in the header region.
- Detail view may use relaxed line spacing; compact form stays single-line where the UI contract allows.

### Whitespace

- Channels separated by whitespace or neutral separators — not three bordered pills.
- Do not wrap each channel in its own card.

### Contrast

- Healthy Agent channel: `quiet` — may show "online" at tertiary or omit value entirely.
- Healthy Session + attachment: `tertiary` / `secondary` — readable but never accent-colored.
- Degraded channel only: `conditional-prominent` — that channel's value and indicator gain emphasis; siblings unchanged.

### Surface treatment

- Flat inline metadata — no elevation, no per-channel backgrounds in compact form.
- Detail form may use hairline dividers between stacked rows; not bordered cards.

### State-driven emphasis

Normative example (Agent `offline`, Session `active`, attachment `detached`):

| Channel | Emphasis | Must read as |
|---------|----------|--------------|
| Agent | `conditional-prominent`, high | Connectivity problem |
| Session | `secondary` / `tertiary` | Session still exists |
| Attachment | `tertiary` | This client not attached — not "Session dead" |

See **States → Canonical example** above for copy rules.

### Anti-patterns

- One chromatic dot encoding Agent + Session + attachment (shipping predecessor).
- "Session offline" when Agent is the failing dimension.
- Color-only encoding without accessible labels.
- Three accent colors in one compact line.
- Prominent healthy "online" badges (violates P3 — system must not advertise health).

### Canonical reference

- Web: `/#/fixture` 1440×900 — `server: connected` and header status fragments ([#563](https://github.com/BestNathan/nession/pull/563)).
- App: `/#/fixture/app` 390×844 — header status compressed beside Session title ([#568](https://github.com/BestNathan/nession/pull/568)).

## Acceptance

- [ ] Three channels are labeled (visually or via accessible name).
- [ ] Agent offline + Session still present does not render as a single “Session offline”.
- [ ] Attachment `failed` is distinct from Agent `error`.
- [ ] No Primitive palette classes on the indicators.
