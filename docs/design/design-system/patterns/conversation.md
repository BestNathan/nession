# Conversation

## Purpose

A Conversation is an AI provider's transcript read as a *conversation*: what the
user asked, what the assistant answered, and the work it did in between. It is a
Nession-owned pattern — not a Claude Code pattern, not a Codex pattern — because
`PRINCIPLE.md` §5 says extensions provide capability while Nession owns the
experience, and a second provider must not arrive with a second chat.

The provider supplies facts. This pattern decides hierarchy, disclosure and
density, and it decides them once.

## Contextual anatomy

A turn is a **location**, not a container. The transcript is a flat ordered list
of items; "which turn" and "which step of it" are properties carried by each
item. That is what lets the process fold without re-parenting the rows inside
it — and re-parenting is what would remount them.

```text
user message                     ← opens the turn
turn process control             ← one line: "Worked" / "Worked for 12s"
  ├─ tool activity rows          ┐
  ├─ reasoning / status rows     ├─ the process window
  └─ …                           ┘
assistant answer                 ← the turn's main content
turn actions                     ← copy, and whatever the surface adds
```

Rows that are **not** the assistant's work — the user's own message, a status
notice, the turn's terminal state — never fold into the process. A user's
message disappearing into the assistant's work would invert whose turn it is.

## Hierarchy

Three weights, and they are not interchangeable:

1. **The answer is the content.** Assistant prose is a reading column, not a
   card: its Markdown carries its own typography, and a surface drawn around it
   is chrome that says nothing.
2. **The user's message is a bounded surface.** Right-aligned, noticeably
   narrower than the reading column, because a short prompt should be a short
   bubble rather than a full-width block.
3. **Work sits below both.** Tool and reasoning rows are lower-emphasis by
   structure, not only by colour: they are the thing you *can* inspect, not the
   thing you came to read.

A provider's identity may vary exactly two things: the assistant's label, and
which tool summaries it produces. It may not vary the hierarchy, the spacing
scale, the message anatomy or the interaction rules — there is no vocabulary in
the adapter contract for it to do so.

## Density

```text
process row gap           8px     (16px when an expanded group is open)
assistant response gap    16px
turn / process gap        16px    (8px from a collapsed process to its answer)
expanded group title gap  16px
group body cap            min(400px, 50vh)
group edge fade           24px
```

These are **relationships, not literals**: they are owned as tokens so App may
state different numbers without a component changing. A component that hard-codes
them has re-created the feature-local metric this section exists to prevent.

The rhythm is what makes a long transcript scannable: work is separated from
work by the tight gap, and the answer is separated from the work by the loose
one. Collapsing a process group must not leave the space it used to occupy —
see the zero-height rule under Progressive disclosure.

## Visual contract

### Surface

- The assistant has no bubble.
- The user's bubble uses the `conversation.user.*` domain surface; it does not
  borrow the accent of an action.
- Work rows use the `conversation.tool.*` surface — the *activity* role, not a
  participant's.
- Code inside either body is `conversation.code.*`.

### Status

Outcome is carried in words as well as colour. Healthy success needs no strong
colour: a successful call is the quiet default, and only failure earns
emphasis. An outcome the provider could not determine says so — it is never
drawn as success.

### Geometry stability

Nothing that appears on hover, on focus, or as a result of streaming may move
the content below it. Rows that reserve space and change only their opacity are
the mechanism; `display` changes are not.

## Progressive disclosure

```text
rest
    -> the answer, the user's message, one line per process group

inspect
    -> a group's rows, a row's output

explicit detail
    -> a payload's full body, when it was truncated
```

Outer disclosure outranks inner on **visibility**; inner outranks outer on
**layout**. A collapsed outer group hides its members whatever they think, and
an expanded inner group lays itself out freely inside whatever space it has.

Three rules make that safe:

- **A collapsed row is hidden, not unmounted**, and a hidden row contributes
  neither its height nor its sibling gap. Without the second half, collapsing
  leaves a hole exactly the size of what was closed.
- **Focus is never stranded.** Collapsing reveals rather than hides when the
  focused element is inside; toggles move focus to their own control first.
- **Streaming keeps identity.** A running message and its settled form are the
  same row with a different status — never a replacement — so finishing a
  response does not remount it.

## Scroll

The transcript owns its own scroll.

- Opening a conversation and explicitly asking for a new turn follow the tail.
- A reader who has scrolled up stops being followed, and streaming growth does
  not drag them back.
- Loading older history preserves the reading anchor.
- A group with its own scroll hands the wheel to the transcript at its edges,
  naturally rather than by intercepting events.
- Jump-to-bottom is a floating control that appears when it is useful, not a
  permanent toolbar.

## Tokens

| Part | Tokens |
|------|--------|
| User / assistant / tool surfaces | Domain `conversation.*` |
| Code inside a body | Domain `conversation.code.*` |
| Text hierarchy | Semantic text roles via the Experience typography roles |
| Row gaps, group cap, edge fade | Experience `conversation.*` |
| Reading column and bubble caps | Experience `conversation.*` |
| Fold control, action rows | Experience `control.*` / `conversation.*` |

Do not use Primitive palette colours directly, and do not restate a density
value at a call site.

## Web vs App

The semantic hierarchy is identical. Only the measurements differ.

| | Web | App |
|--|-----|-----|
| Density | Compact, reading-oriented | Touch-safe, same rhythm |
| Secondary actions | Revealed on hover/focus | Always reachable; one-at-a-time reveal |
| Bubble width | A fraction of the reading column | Wider, capped to the viewport |
| Long bodies | Capped, scroll inside | Same, with a smaller cap |

## Anti-patterns

- A provider-specific renderer for a core row (a Claude tool card, a Codex tool
  card) instead of an adapter supplying facts.
- Wrapping the assistant's whole response in a card.
- Giving work the same weight as the answer.
- Per-tool cards where a grouped row would do.
- A collapsed row that leaves the gap it used to occupy.
- Hover-only access to an action, or a reveal that shifts the content below it.
- Treating "the provider did not say" as success or as failure.
- A second Markdown path for a second provider.
- A green success badge on every completed call.

## Acceptance for future implementation work

- [ ] Hierarchy holds with a second provider: answer first, work below.
- [ ] The same renderer serves every provider; adapters supply facts only.
- [ ] Density comes from tokens, and App can state its own numbers.
- [ ] Collapsing and expanding move nothing outside the affected group.
- [ ] Focus survives every disclosure transition.
- [ ] Streaming keeps a row's identity from running to settled.
- [ ] Touch reaches every action without hover.
- [ ] Outcome is legible without colour, and `unknown` is never drawn as success.
