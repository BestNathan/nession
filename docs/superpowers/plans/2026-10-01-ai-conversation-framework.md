# Provider-agnostic AI Conversation Framework

Requirement: **#1363** — establish a Nession-owned, provider-agnostic AI Conversation
model, runtime and shared UI, with Claude Code as the first adapter.

## Why this branch is based on `origin/staging`

SC-09 requires that every AI provider's text blocks render through #1184's
`ChatMarkdown`. That work is **merged to `staging`** (PRs #1358 / #1359) but was not in
the last release (`#1357`), so it is not on `main`. Basing this work on `main` would
build the shared renderer against the pre-#1184 Markdown path and re-litigate the
integration on merge. The worktree was therefore created from `origin/staging`
(`92598439`, the `#1362` merge).

The root checkout (`main`) does **not** contain `ChatMarkdown`; a survey that reads it
will wrongly conclude #1184 never landed. Verify with:

```bash
git ls-tree origin/staging -- web/src/shared/markdown/
```

## What already exists (measured, not assumed)

The extraction is smaller than the requirement text implies, because #1222 already
converged the wire onto an item model that is very close to canonical:

| Today | Path | Lines |
|---|---|---|
| Wire item union (`message` / `tool` / `unknown`, `ToolStatusV1`, `PayloadV1`) | `web/src/generated/protocol/claude-code/messages/v1.ts` | 234 |
| List + binding | `capabilities/claude-code/hooks/useConversations.ts` | 125 |
| One conversation's timeline, paging, poll, generation guards | `capabilities/claude-code/hooks/useMessages.ts` | 320 |
| Prepend/poll merge + object reuse | `capabilities/claude-code/model/messagePositions.ts` | 122 |
| Selection + poll composition | `capabilities/claude-code/hooks/useConversation.ts` | 170 |
| Transcript renderer (user/assistant/tool) | `capabilities/claude-code/components/ConversationTranscript.tsx` | 465 |
| List + detail composition | `capabilities/claude-code/components/ConversationView.tsx` | 572 |
| Peek detail overlay (its own `useConversation`) | `capabilities/claude-code/components/ConversationOverlay.tsx` | 38 |
| Workspace shell for both experiences | `capabilities/claude-code/components/ClaudeCodeWorkspace.tsx` | 714 |
| Scroll primitive (#1267) | `web/src/components/ui/message-scroller.tsx` | 123 |
| Chat markdown (#1184) | `web/src/shared/markdown/{ChatMarkdown.tsx,runtime/}` | — |

Three surfaces render the same transcript today:

1. **Web Workspace** — `ClaudeCodeWorkspace` → `ConversationView` (`master-detail`).
2. **App Workspace** — the same component with `layout="push"`.
3. **Terminal capsule Peek → detail overlay** — `ConversationOverlay` mounts a *second*
   `useConversation` and its own `ConversationTranscript`.

The wire already carries `id`, `kind`, `role`, `status`, `call_id`, `summary`, `input`,
`output`, `timestamp`, `partial_tail`, `skipped` and `activity: active | inactive |
unknown`. **The canonical model is therefore a generalisation of the existing wire
union, not an invention.** That is the single biggest de-risking fact in this plan.

## Upstream baselines (SC-16)

Copied or adapted source must record repository / commit / path / license, and the
commit must be pinned so acceptance is reproducible.

| Project | Baseline commit | License | Used for |
|---|---|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | `6d7d81fb569ea3413b26f41cc4522252840dcd18` (2026-10-01) | MIT, © 2026 OpenClaw Foundation | grouping, tool/activity disclosure, hover/focus reveal, layout-stable footer, streaming group |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | `21638c56315ae6a2b552d6091945d3144c9af32e` (2026-09-27) | MIT | reading density, Turn → Process Group → Tool disclosure, running status, jump-to-bottom, focus-preserving collapse |

OpenClaw is a ~7 GB repository and is **not** checked out locally; the port uses a
sparse checkout of `ui/src/lib/chat/**`, `ui/src/pages/chat/**` and
`ui/src/styles/chat/**` at the pinned commit. DeepSeek Harness's `ui-chat`,
`ui-conversation`, `ui-slots` and `ui-renderer` packages are the second source.

`THIRD_PARTY_NOTICES.md` (new, repo root) records every adopted file with the header
form the requirement fixes:

```text
Upstream: <repository>
Baseline: <commit>
Source: <path>
License: MIT
Adaptation: <what changed for Nession>
```

**Debt inherited, not created here:** #1184 vendored the DeepSeek markdown parser
(`web/src/shared/markdown/runtime/`) recording provenance only as prose in two file
comments ("adapted from DeepSeek Harness MarkdownText.module.css"), with no commit or
license record. This plan backfills those entries into `THIRD_PARTY_NOTICES.md` so the
repository has one consistent convention rather than two.

## Target ownership

```text
web/src/shared/ai-conversation/          # Nession-owned, provider-agnostic
  model/
    conversation.ts                      # summary, activity
    content.ts                           # content union + bounded fallback
    activity.ts                          # tool/status items
  adapter/
    types.ts                             # AIConversationAdapter, context, page
    contract.ts                          # capability declaration (refresh policy)
  runtime/
    ConversationRuntime.ts               # React-free state machine
    reconcile.ts                         # newest-page merge, identity reuse
    pagination.ts                        # older-page window + cursor ownership
    useConversationSnapshot.ts           # useSyncExternalStore bridge (React)
  components/
    ConversationView.tsx                 # list + detail composition
    ConversationList.tsx
    ConversationTranscript.tsx
    ConversationMessage.tsx              # user bubble / assistant reading column
    ToolActivity.tsx                     # collapsed summary + disclosure
    ConversationState.tsx                # loading / empty / error / partial tail
  index.ts

web/src/capabilities/claude-code/conversation/
  adapter.ts                             # ClaudeCodeConversationAdapter
  normalizers.ts                         # wire item -> canonical item
```

Rules the layer gate already enforces (`nession/no-reverse-imports`):

- `shared` may import only `components/ui` and itself. The framework therefore **cannot**
  name a provider, and cannot import `capabilities/**` — the layer rule, not review, is
  what keeps SC-01 and SC-10 true.
- `capabilities/claude-code/conversation/**` may import `shared/ai-conversation/**`.
  The arrow points one way.
- Provider adapters must not import shared renderer internals; only `index.ts` is public.

`provider` identity reaches the UI only as data on the adapter (`id`, `label`), never as
a React node. There is no JSX hole in the contract (SC-10).

## Canonical model

Derived from the converged #1222 wire rather than invented:

```ts
type AIConversationActivity = 'active' | 'inactive' | 'unknown'

interface AIConversationSummary {
  id: string
  title?: string | null
  preview?: string | null
  activity: AIConversationActivity
  updatedAt?: string | null
}

type AIConversationItem = AIMessageItem | AIToolItem | AIUnknownItem

interface AIMessageItem {
  kind: 'message'
  id: string
  role: 'user' | 'assistant'
  timestamp?: string | null
  content: AIConversationContent[]
}

type AIConversationContent =
  | { type: 'text'; text: string }
  | { type: 'unknown' }

interface AIToolItem {
  kind: 'tool'
  id: string
  timestamp?: string | null
  callId: string
  name: string
  status: 'running' | 'success' | 'error' | 'unknown'
  summary: string
  input?: { text: string; kind: 'json' | 'text'; truncated: boolean } | null
  output?: { text: string; kind: 'json' | 'text'; truncated: boolean } | null
}

interface AIUnknownItem { kind: 'unknown'; id: string; timestamp?: string | null }
```

Deliberate differences from the requirement's sketch, and why:

- **`AIStatusItem` is not in v1.** No provider on the wire emits a status item; the
  requirement's own constraint says "新 common semantic 必须先证明能由 Nession 统一呈现"
  and "不要为尚未存在的 provider feature 预先设计大量 union". Status text today is
  runtime state (loading / error / partial tail), which the runtime owns and the
  renderer draws from `ConversationState`, not from a transcript item.
- **`image` / `file` content variants are not in v1**, for the same reason: the wire
  has `{type:'text'}` and `{type:'unknown'}` only. Unknown blocks already degrade
  visibly (SC-10) through the existing `unknown` arm.
- **Tool stays nested in the wire but flat in canonical** (`callId`, `name`, … on the
  item rather than under `tool`) so the renderer reads one shape.
- **`activity` sits on the summary**, not on each item.

If a second provider later emits images, status rows or citations, the union grows then
— against a demonstrated need, as the requirement's "novel provider blocks" rule says.

## Adapter contract

```ts
interface AIConversationAdapter<Context> {
  readonly id: string
  readonly identity: { label: string; icon?: LucideIcon }

  list(context: Context): Promise<AIConversationListResult>
  read(context: Context, conversationId: string, cursor?: string): Promise<AIConversationPage>

  readonly refresh:
    | { kind: 'poll'; intervalMs: number }
    | { kind: 'push'; subscribe: (onChange: () => void) => () => void }
    | { kind: 'manual' }
}
```

`list` returns the directory **and the provider's exact binding** (the conversation the
current context implies), because #1222 established that auto-open follows an exact id
the provider named — never a guess from a timestamp or a list of one.

The adapter is React-free. Context is provider-shaped (`{ agentId, sessionId }` for
Claude Code) and opaque to the runtime.

## Runtime responsibilities

Everything `useConversation` does today that is *not* Claude-specific moves into
`ConversationRuntime`, which is React-free and consumed through
`useSyncExternalStore`:

- context key + generation (stale responses cannot mutate a newer conversation);
- explicit selection, tagged with the context it was made in;
- binding fallback (exact id only);
- independent list and thread loading/error state;
- newest-page refresh; older-page pagination with its **own** generation so a poll
  cannot drop an in-flight older page (#1190's bug, already fixed in `useMessages`);
- prepend merge with object reuse for unchanged items (the Markdown re-parse saving
  that `messagePositions.reusing` documents);
- refresh policy from the adapter: `poll` arms a timer, `push` subscribes, `manual`
  does neither — the UI branches on nothing (SC-06);
- partial tail, skipped count, retry, reload, disposal.

The three behaviours worth stating explicitly, because they are the ones most likely to
regress during extraction:

1. **Two request generations, not one.** A poll and an older-page fetch are concurrent;
   one counter would let either invalidate the other.
2. **`loadingOlder` is owned by the older fetch.** A whole-object write from the poll
   would stamp `loadingOlder: false` over an in-flight page, killing the spinner and
   letting a second pull double-fetch it.
3. **Cursor ownership.** The older cursor follows the newest page only while the user
   has not paged back; afterwards it is theirs and polls leave it alone.

## Stages

Each stage is a commit on this branch and passes the full gate (`just test`,
`just coverage`, `just web-lint`, `just web-test`, `just web-coverage`,
`just design-check full`). Stages 1–2 can land together; 3 depends on both.

| Stage | Content | Criteria |
|---|---|---|
| **1. Model + contract + runtime** | `model/`, `adapter/`, `runtime/`; React-free runtime with unit tests driving a synthetic in-memory adapter (poll **and** push) | SC-01, SC-02, SC-06, SC-07, SC-11, part of SC-12 |
| **2. Shared renderer + upstream port** | `components/`; OpenClaw + DSH source port mapped to Nession tokens; `THIRD_PARTY_NOTICES.md` + #1184 backfill | SC-03, SC-08, SC-09, SC-10, SC-16, SC-17, SC-18 |
| **3. Claude Code migration** | `ClaudeCodeConversationAdapter` + `normalizers`; route Workspace + Peek through the shared view; delete provider-local generic chat | SC-04, SC-05, SC-13, SC-14 |
| **4. Conformance + documentation** | second synthetic provider through the *shared UI*; onboarding doc; acceptance evidence | SC-12, SC-15, SC-19, SC-20 |

## Known costs

- **Three golden baselines move** — `app-claude-code-conversation-linux.png`,
  `web-claude-code-conversation-linux.png`, `web-claude-code-conversations-linux.png`.
  They are regenerated in CI (`CI=true npx playwright test fixture-visual
  --update-snapshots=all`) in the same change set, after reviewing the diff. Local e2e
  runs are forbidden. `maxDiffPixelRatio` is **not** widened.
- **Web coverage** (lines 80 / functions 72 / statements 78 / branches 65) must hold
  with the new framework added; the runtime is unit-testable in the `node` project,
  which is where the coverage should come from rather than from component snapshots.
- **The `assistant` streaming identity** (SC-19) is the requirement's hardest runtime
  property. It is asserted in Stage 1 at the model level (stable ids, one growing item,
  no duplicate rows) and re-verified in the browser in Stage 4 — because a model-level
  assertion cannot see a React remount.

## Deliberate deviations from the requirement

Recorded here, per the requirement's own instruction that deviations be stated:

1. **`AIStatusItem`, image and file content are deferred**, with the reasoning above.
2. **The wire's tool nesting is flattened** in the canonical item.
3. **#1184's vendor notice is backfilled** rather than left as prose, so the repository
   has one convention.
4. **The `openId`/`selected` distinction is preserved as-is.** The requirement sketches
   a simpler selection model; #1222 measured that the open conversation must survive a
   `not_found` response, which deriving "open" from the response body cannot do.

## Non-goals (unchanged from the requirement)

No unified backend protocol, no provider-specific parser convergence, no transcript /
trajectory merge (#1234 stays separate), no Codex implementation, no composer / send /
approval UX in v1, no second design-token system.
