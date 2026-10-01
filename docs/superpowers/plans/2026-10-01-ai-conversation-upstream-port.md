# AI Conversation — upstream UI/UX port spec

Companion to [`2026-10-01-ai-conversation-framework.md`](./2026-10-01-ai-conversation-framework.md),
covering **stage 2** (the shared renderer) for requirement #1363.

This document exists so the port can be implemented and reviewed without
re-reading two large upstream repositories. Every number here was read from the
pinned baseline, not remembered, and every mechanism is named with the file it
was read from.

> **Scope.** This is the *implementation brief* for the port. The requirement's
> SC-16 … SC-20 are the acceptance criteria; this says what to build to meet
> them. Where a value below is an upstream value, it is stated as upstream — the
> Nession number is decided in §4, against this repository's own tokens.

## 0. Baselines

| Project | Commit | License | Copyright |
|---|---|---|---|
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | `21638c56315ae6a2b552d6091945d3144c9af32e` | MIT | Copyright (c) 2026 DeepSeek |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | `6d7d81fb569ea3413b26f41cc4522252840dcd18` | MIT | Copyright (c) 2026 OpenClaw Foundation |

Neither project puts a licence header in the ported files — both carry licensing
at the repository root only. So the per-file header Nession adds is a **local
requirement**, not an upstream one, and `THIRD_PARTY_NOTICES.md` is where the
register lives.

A sparse checkout of either is enough; neither needs a full clone:

```bash
git init /tmp/openclaw
git -C /tmp/openclaw remote add origin https://github.com/openclaw/openclaw.git
git -C /tmp/openclaw sparse-checkout set --cone ui/src/lib/chat ui/src/pages/chat ui/src/styles/chat
git -C /tmp/openclaw fetch --depth 1 origin 6d7d81fb569ea3413b26f41cc4522252840dcd18
git -C /tmp/openclaw checkout FETCH_HEAD
```

## 1. The model to port: Turn → Process → Tool

DeepSeek Harness's structure is the one the requirement adopts, and the
important half of it is that **a turn is a location, not a container**. A
transcript is a flat ordered list of nodes; "which turn" and "which step of it"
are properties on each node. That is what lets the renderer fold a *window* of
rows without re-parenting them, and it is why a fold does not remount the
messages inside it.

```text
[user | turn-trigger]              ← opens the turn
 turn-process                      ← the fold control row, one line
   ├─ tool rows                    ┐
   ├─ reasoning rows               ├─ the process window
   └─ …                            ┘
 assistant-step (the answer)       ← the final reply; owns the answer boundary
 turn-error | turn-max-tokens      ← terminal notices
 turn-tail                         ← per-message actions, usage
```

The process window is everything anchored at or after `processStartSeq` and
before `answerAnchorSeq`. Rows whose kind is *independent* — user, steering,
turn-trigger, turn-process, turn-tail, and the terminal notices — never fold
into a process group, which is what stops the user's own message disappearing
into Claude's work.

**Default disclosure.** Of the four upstream presentation modes, Nession adopts
the behaviour of `standard`: completed turns fold their process, group bodies
are collapsed, live process detail is shown while running, and settled reasoning
gets a preview. Whole-turn folding is *unavailable* — and the turn stays open —
while the turn is still open, and when it ended aborted or errored.

**Collapsed vs running.**

| | running | completed |
|---|---|---|
| fold control | not rendered | one line: `Worked` / `Worked for 12s` |
| group header | live activity title, `preparing` before the first tool | closed title from the top categories ("Read, searched, edited") |
| fold state | always open | collapsed |
| tail | none | actions + usage |
| column end | running indicator | nothing |

## 2. Density (upstream values, verified)

These are the numbers the requirement quotes, with their source rules. **Do not
copy the token names** — they belong to DeepSeek's theme; §4 maps the numbers
onto Nession's own vocabulary.

| Concept | Upstream value | Source |
|---|---|---|
| Reading column max width | `clamp(680px, column × 0.64, 920px)` | `ui-conversation/…/ConversationRoot.module.css` |
| Column row gap | `16px` (`--dsh-chat-flow-gap`) | `ChatView.module.css` |
| — closed process → answer | `8px` | `ChatView.module.css` |
| **Process row gap** | `8px` | `ChatGroupSeat.module.css` |
| — expanded group | `16px` | `ChatGroupSeat.module.css` |
| **Group max body height** | `min(400px, 50vh)` | `ChatGroupSeat.module.css` |
| **Group edge fade** | `24px` mask stop | `ChatGroupSeat.module.css` |
| **Expanded group title gap** | `16px` padding-bottom | `ChatGroupSeat.module.css` |
| Group header leading box | `16px × 16px` | `ChatGroupSeat.module.css` |
| Fold control height | `33px` | `TurnProcessNodeView.module.css` |
| Fold control rule | `0.5px` bottom border; `8px` extra margin when collapsed | `TurnProcessNodeView.module.css` |
| **Assistant response gap** | `16px` | `AssistantMarkdown.module.css` |
| **User bubble max width** | `min(column × 0.702, 82%)` | `MessageItem.module.css` |
| — narrow-screen | the `82%` arm of that `min()` | `MessageItem.module.css` |
| User bubble padding / radius | `10px 16px` / `20px` | `MessageItem.module.css` |
| Action row | height `28px`, hit target `28px`, padding `6px`, radius `8px` | `MessageIconActions.module.css` |
| Running block gap / text | `12px`, icon `14px` | `ChatView.module.css` |
| Jump-to-bottom | `34px × 34px`, radius `100px` | `ChatView.module.css` |
| Timing | follow threshold `24px`, scroll sample `500ms`, live clock `1000ms`, title de-flicker `150ms` | `use-chat-reading.ts`, `message-chrome.ts`, `ChatGroupSeat.tsx` |

## 3. Mechanisms worth porting exactly

These are the load-bearing tricks. Each one exists because the obvious
implementation has a defect, and the defect is named.

1. **Zero-height hidden rows.** A collapsed row is `hidden="until-found"`, and
   the gap selectors are written `:not([hidden]):not(:empty) ~ …` so a hidden
   row contributes neither height *nor the sibling gap*. Without this, folding a
   group leaves the space it used to occupy. `hidden="until-found"` (rather than
   unmounting) is also what keeps browser find able to reveal the row.

2. **Opacity, not `display`, for hover-revealed actions** — gated on
   `@media (hover: hover)`, and revealed on `:hover` **and `:focus-within`**.
   `:focus-within` rather than `:focus` is what keeps a row visible while a
   keyboard user tabs through the controls inside it. On touch the media query
   never matches, so actions are simply always visible — which is the
   requirement's "touch/no-hover 下关键操作必须直接可达".

3. **Focus before toggle.** Every disclosure's handler calls
   `currentTarget.focus()` *then* toggles, and the searchable-hidden helper
   refuses to hide a subtree containing `document.activeElement` (it reveals
   instead). Collapsing must never strand focus in a removed subtree.

4. **Generation-reset disclosure.** `useDisclosure(version)` derives
   `expanded = expandedVersion === version` instead of storing a boolean, so a
   version bump collapses the row *without an effect* — no intermediate render
   in which stale expansion is visible.

5. **Intent vs offset for scroll following.** `following` is the reader's
   intent, sampled only when the reader actually moved and no programmatic
   animation is outstanding. `interrupt()` pins the current offset before a
   reader gesture, so a gesture wins over an in-flight smooth scroll. Reduced
   motion downgrades `smooth` to `instant`.

6. **Prepend anchor protocol.** `beginPreserving()` records a semantic anchor,
   `preserve()` returns a compensating landing, and the reading policy
   (`followingTail`, active turn) is carried *unchanged* across the prepend.
   Released when the reader moves.

7. **Nested group scroll hands off through CSS, not JavaScript**:
   `overscroll-behavior-y: auto` on the capped body chains to the transcript at
   its edges. There is no wheel-routing code, and the group's own follow
   controller is deliberately not coupled to the transcript's.

8. **Streaming identity.** Running, settled and interrupted share **one keyed
   renderer instance**; the status is a field on the same node, so settling does
   not remount. Text and reasoning blocks are keyed by their *original* block
   index so an append extends the group instead of shifting keys.

9. **Live-title de-flicker**: a live title is held for `150ms` before being
   replaced, and the timer reads the latest desired value rather than the one
   captured when it was scheduled.

## 4. Mapping onto Nession

The requirement is explicit that "直接拿过来用" means **source and interaction
semantics, not branding or tokens**: drop the palette, the font scale, the
radius/elevation scale, the mascot, the upstream router links and the Lit-only
implementation details; keep DOM anatomy, hierarchy, relative spacing,
disclosure levels, action placement, hover/focus/touch rules, streaming
transitions, scroll ownership and layout-stability tricks.

### What already exists here

`design/tokens/domain.json` already owns a `conversation` block —
`user.{surface,foreground}`, `assistant.{surface,foreground}`,
`tool.{surface,foreground,error,success}`, `code.{surface,foreground,border}` —
and `ConversationTranscript.tsx` already consumes it as
`var(--conversation-*)`. **The port keeps that vocabulary**; it is the same
domain meaning, and replacing it would be churn.

### What is missing, and where it must go

The density above has **no Nession vocabulary today**. Per
`nession-web-design`'s iron law, the missing concept is extended at its
canonical owner rather than hidden in a component class string:

| Concept | Owner | Why there |
|---|---|---|
| conversation row/response/control gaps | `design/tokens/domain.json` → `conversation.*` | Nession domain meaning, shared by every provider |
| group body cap, edge fade | same | a conversation-reading decision, not a generic control metric |
| reading column max width, user bubble max width | `design/tokens/experience/{web,app}.json` | the Web/App split is exactly a presentation difference |
| fold control height, action row height/hit target | Experience | control density is what Experience tokens are for |

Then `just tokens-gen`, and commit source with generated output.

**The 6/12/16 rhythm is adopted as a relationship, not as three literals.**
SC-17 asks for an "equivalent" rhythm: the values map onto the domain tokens
above, and the Experience layer may state different numbers for App without any
component changing. A component that hard-codes `gap-2`/`gap-4` re-introduces
exactly the feature-local metric the design gate exists to catch.

### Deliberate divergences to record in the implementation PR

- **The running indicator is not ported.** Upstream it is a 23-contour whale
  tail plus a `TextShimmer` primitive — both DeepSeek branding. Nession keeps
  the *shape* of the signal (a low-emphasis running row at the column end,
  with a live duration in `tabular-nums`) and drops the mark.
- **Presentation mode switching is not ported.** `compact | standard |
  detailed | verbose` is an upstream settings concept. v1 adopts `standard`'s
  behaviour; the requirement asks only that the structure not make the modes
  impossible later.
- **Node vocabulary is Nession's.** Upstream kinds such as `steering`,
  `compaction`, `model-retry`, `turn-max-tokens`, `system-prompt` and `command`
  are DeepSeek agent semantics with no counterpart in the shared model. A
  record that maps to nothing becomes the model's `unknown` arm, visibly.
- **i18n strings are re-authored**, not copied. Upstream composes the group
  title from a category grammar with English-shaped joiners; Nession writes its
  own strings with the same *shape* (categories, not tool names).
- **The host-coupling surface is dropped**: `openFile` / `openSkill` /
  `inspectCall` / `loadImage` / `fileMediaUrl` are upstream host contracts. The
  shared renderer takes at most a copy action in v1; anything else is a
  capability's business and reaches it through the surface, not through the
  protocol.
