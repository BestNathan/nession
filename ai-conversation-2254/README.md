# AI Conversation — Text-native business components (Issue #2254)

[Requirement #2254](https://github.com/BestNathan/nession/issues/2254) · [Interactive prototype](index.html) · [Protocol](PROTOCOL.md) · [JSON Schema v1](schema.v1.json) · [Parser smoke checks](smoke-test.mjs)

## Scope and fidelity

A **mock-only**, dependency-free interactive browser prototype on the shared orphan `prototype` branch. It demonstrates **System Two / AI Conversation** rather than #2221's **System One / AI Workspace Scene** interaction model. Both user and assistant messages use only the existing text Content; Markdown-fenced JSON directives are parsed into registered, interactive mock business views. The client can serialize component references back into user Text.

All Agent, Session, Git facts, model responses, state decisions and business mutations are local fixtures/simulations. No Nession Server, TransportPlugin, AI provider, auth, xterm or persistent instance store is connected. No production change, deployment, PR merge, or acceptance is claimed.

## Try these flows

1. Open index.html in a browser. The entry is intentionally quiet, with no sidebar/navigation catalog; the composer and contextual suggestions are the only starting surface.
2. Click **查看 Agent**. Observe an assistant Text answer streaming, a partial JSON fence held as pending, then a live mock Agent-list view replacing it after a complete validated fence.
3. Select **Beijing Server**. The inspector's live projection changes (selected agent and allowed actions); a selected offline agent would not expose create.
4. Click **发给 AI** on the list. A *user text message* containing a fenced reference to cmp_001 appears, followed by the assistant's inline **Session creation form**.
5. Change the name and explicitly submit. A mock Session appears with an assistant detail view. Nothing in the real Nession backend is mutated.
6. Type **再看之前的 Agent 组件**; the same registered instance is rendered in a later message with shared selection state.
7. Click **协议检查** to inspect actual Text Content, parsed segments, current state/actions and simulated event log. Click **异常演示** for strict-JSON/op validation fallback. Click **重置** for a blank start.
8. Resize to mobile width; component views remain bounded by the conversation column.

## Files

| File | Role |
|---|---|
| index.html | standalone browser entry (relative bundled assets only) |
| styles.css | restrained Nession-inspired conversation and business-view presentation |
| app.mjs | mock conversation model, streaming presentation, component registry/instance store, interactive Agent/Session/Git views |
| content-parser.mjs | deterministic text-only fenced JSON parsing and reverse serialization |
| schema.v1.json | fixed JSON Schema 2020-12 envelope; components have separate input/context schemas |
| PROTOCOL.md | ownership, security, lifecycle, streaming and future production boundaries |
| smoke-test.mjs | dependency-free Node parser tests, not a browser/E2E suite |

## Local preview / checks

Open index.html in a browser from the same directory; ES modules require an HTTP static server on some browsers, for example:
- From the prototype branch: python3 -m http.server 8000
- Browse: http://localhost:8000/ai-conversation-2254/

Run node ai-conversation-2254/smoke-test.mjs from the branch root. A passing parser smoke is **not** equivalent to running the real Nession design gate, Chromium acceptance or production React integration.

## Design follow-ups

The real implementation needs a production mdast-aware fence parser, two-stage JSON Schema validation (envelope + component), scoped instance identity across history/devices, permissions and stale-reference rules, ChatMarkdown/MessageScroller integration, a business-component adapter layer owned by App composition, responsive/keyboard/browser tests, and trust-bounded component state/action projections. Production Nession business APIs remain the single source of authority.
