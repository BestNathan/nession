# AI Conversation

`web/src/shared/ai-conversation/` is Nession's conversation experience, owned
once and shared by every AI provider. This document is the model, the contract
and the onboarding steps for a new provider.

Requirement: **#1363**. Design rules: `docs/design/design-system/patterns/conversation.md`.

## The one rule

> Extensions provide capability; Nession owns the experience. (`PRINCIPLE.md` §5)

A provider supplies **facts** — what conversations exist, what one says, how it
changes. Nession decides hierarchy, density, disclosure, scroll, streaming
presentation and every empty/failure state. There is no vocabulary in the
adapter contract for a provider to decide any of the latter.

## Layers

```text
provider protocol + API                    provider-owned
        │
        ▼
AIConversationAdapter                      provider-owned: translation only
        │  canonical model
        ▼
ConversationRuntime                        Nession-owned, React-free
        │  immutable snapshot + commands
        ▼
shared components                          Nession-owned
        │
        ▼
surface composition                        Peek / Workspace
```

| Layer | Owns | Must not |
|---|---|---|
| `model/` | the canonical vocabulary | name a provider |
| `adapter/types.ts` | the contract a provider implements | contain a React node |
| `runtime/` | selection, paging, refresh, reconciliation, stale guards | know a transport |
| `components/` | every pixel and every interaction | branch on a provider |

The import direction is enforced by `nession/no-reverse-imports`, not by review:
`shared/` may not import any business layer, so the framework **cannot** name a
provider even by accident.

## The canonical model

`AIConversationItem` is one of `message`, `tool`, `reasoning` or `unknown`; a
conversation is `AIConversationSummary`. The full definitions are in
`model/{conversation,content,activity}.ts` and are the source of truth.

`reasoning` has no provider emitting it yet. It is in the model because the
requirement names it and the transcript renders it, so the shape is settled here
rather than invented by the first provider that needs it — the same reasoning
that put the item union in a shared file instead of in one adapter.

Three properties matter more than the field lists:

- **`id` is a contract.** It is stable within a conversation, and it is what
  keeps object identity across a refresh — which is what keeps a long
  transcript's Markdown from being re-parsed every three seconds.
- **`unknown` is an outcome, not a bug.** A record the model does not name is
  shown as unmodelled. Silently dropping it renders a conversation as shorter
  than it was.
- **Absent means the provider did not say.** Do not infer `status`, `activity`
  or an outcome you were not told; `unknown` is a real state and is drawn as
  one.
- **Skipped completeness is a lower bound, not an invented exact union.** A
  provider reports `skipped` per page and pages may overlap, so the runtime
  keeps the maximum count observed across the loaded window and surfaces it as
  “At least N records not shown”. Exact union cardinality would require stable
  identities for skipped records, which the canonical contract does not have.

## Onboarding a new provider

Four steps. None of them is a component.

### 1. Normalize the provider's records

Create `capabilities/<provider>/conversation/normalizers.ts`. Translate the
provider's shapes into the canonical ones and **name every translation** in a
comment, because each is a place where provider information is deliberately
lost.

Rules that were learned the hard way and apply to every provider:

- Drop provider-only fields rather than adding them to the shared summary. A
  field only one provider fills is how a shared model acquires a
  provider-shaped hole.
- Leave fields you cannot honestly fill **absent**. If the provider never says
  whether a message is still being written, do not guess — the page's
  `partialTail` is the shared signal for that, and the renderer applies it.
- Classify tools into `AIToolCategory`. The categories are Nession's; the names
  are yours. An unrecognised tool is `other`, which is honest, not an error.

### 2. Implement the adapter

Create `capabilities/<provider>/conversation/adapter.ts`:

```ts
export const myProviderConversationAdapter: AIConversationAdapter<MyContext> = {
  id: 'my-provider',
  identity: { label: 'My Provider' },
  contextKey: (context) => `${context.a}:${context.b}`,
  requestKey: (context) => context.leaseId,
  async list(context, cursor) { /* → result + nextCursor/listingId/restart */ },
  async read(context, conversationId, cursor) { /* → AIConversationPage */ },
  refresh: { kind: 'poll', intervalMs: 3000 },
}
```

Six decisions, all yours: how to list one directory page, how to read one
timeline page, what makes two contexts the same conversation space, what makes
old in-flight work still authoritative, what makes one list continuation a
coherent snapshot, and how you learn that something changed (`poll`, `push`,
or `manual`). The runtime owns transcript paging/reconciliation and a bounded
complete-list aggregation; a surface never needs a provider-specific "load page
2" branch.

Provider obligations:

- **`nextCursor` is opaque and `listingId` names one coherent directory
  snapshot.** If a continuation is no longer valid because the directory
  re-sorted/rebound, return `restart: true`; never apply an old offset to a new
  ordering. The runtime restarts at most twice and follows at most 32 pages for
  one logical list read. Crossing either bound is a list error that preserves a
  previously readable directory instead of looping forever.
- **`bindingId` is an exact id** the provider named, or `null`. Never a guess
  from a timestamp or a list of one. Every page of one `listingId` must report
  the same binding.
- **`contextKey` is equal exactly when two contexts mean the same conversation
  space.** It scopes selection and visible conversation identity.
- **`requestKey` changes when work issued under the old Context must no longer
  publish.** Providers whose request authority is exactly `contextKey` may omit
  it. If a token/lease/client can rotate while the space stays equal, implement
  it explicitly; object identity is not a request-generation contract.
- **A push policy also supplies `sourceKey(context, conversationId)`.** It is
  equal exactly while the concrete subscription can be reused. Source
  replacement is claimed before `subscribe()` may synchronously signal, and
  the runtime performs a catch-up newest read to close the unsubscribe/subscribe
  delivery gap.


Export the adapter as a module-level constant: the hook treats it as the
provider's identity, so building a new one per render would be asserting that
the provider changed.

### 3. Mount it

```tsx
const { snapshot, select, reload, loadOlder } = useAIConversation(adapter, context)

<ConversationView
  snapshot={snapshot}
  providerLabel={adapter.identity.label}
  layout={experience === 'app' ? 'push' : 'master-detail'}
  onSelect={select}
  onLoadOlder={loadOlder}
  onReload={reload}
/>
```

That is the whole integration. `context` is `null` when you have nothing to ask
about, and the framework renders nothing rather than guessing.

### 4. Prove it with a fixture

Add a conformance test that drives your adapter through the **shared UI** —
listing, opening, grouping, paging, refreshing, and every state. See
`__tests__/integration/secondProvider.test.tsx` for the shape. An abstraction
tested only against its first implementation proves nothing.

## What you get for free, and must not re-implement

User and assistant message rendering · tool rows and their grouping · the
process summary line · disclosure behaviour and focus handling · bounded group
scrolling and edge fades · tail-follow, prepend anchors and jump-to-bottom ·
loading, empty, unavailable, not-found, failure and partial-tail states ·
list and transcript pagination · stale-list preservation · loaded-window
unsupported-record reporting · Markdown (through the shared `ChatMarkdown`).

If one of these does not fit your provider, that is a conversation about the
**shared** model or the shared component — not a reason to fork one.

## Known gaps

- **No composer, send or approval.** v1 is read-only by design; the model and
  runtime are meant to grow into it, and the requirement is explicit that
  unproven interaction semantics are not to be unified early.
- **`AIConversationContent` has only `text` and `unknown`.** Images, files and
  citations are added when a provider demonstrates the need, not in advance.
