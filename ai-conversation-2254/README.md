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

## Shared review frame — 2026-11-06

- **Entry / preview:** `index.html` is a directly accessible interactive review page using the shared `../prototype-frame-2758/frame.css`, `frame.js` and `review-bridge.*`. Its order is Requirement overview → 1:1 CSS-pixel product mock → interaction/fidelity details. Use the original [Requirement](https://github.com/BestNathan/nession/issues/2254) for the current design contract.
- **Behavior:** preserves this directory's existing state transitions; moves fixture controls, reset, test inspectors, and scenario narratives outside the product viewport wherever they are static. Device width controls and full-page Reset belong to the external harness.
- **Fidelity:** Text UI 指令与交互、状态检查器模拟；不连接大模型或 Session 后端。. The original mock's local DOM/CSS is retained; this migration does **not** prove fidelity to React/shadcn, actual xterm, TerminalCapsule, App gesture geometry, or current generated design tokens.
- **Validation:** GitHub source structure and publisher-required source/gallery hooks checked. The new review frame needs an independent Chromium desktop/narrow-viewport walkthrough, keyboard/touch/scroll check, console inspection, and source-vs-fixture visual comparison; **those browser checks are not yet verified**. The public preview is **unverified** until `prototypes/manifest.json` reports the same commit SHA; mock results are never production Acceptance.
- **Publication:** keep the existing direct `https://bestnathan.github.io/nession/prototypes/ai-conversation-2254/index.html` URL, but treat the immutable GitHub source commit as authoritative until Pages HTTPS/manifest readback succeeds.

## 2026-11-06 · Candidate text-native conversation UI ownership correction

**Product category: CANDIDATE AI CONVERSATION extension, NOT the shipped provider-bound Claude Code conversation renderer.** Current main's `shared/ai-conversation` runtime binds provider, context and transcript; #2254 proposes the additional text-fenced `nession-ui` parsing, registered business components, instance lifetime and user-text references. Neither the mock registry nor the synthetic Agent/Session execution is a production API. Do not call this a current `WorkspaceShell` 1:1 rendering.

**Actual screen correction:** previous product DOM had a fabricated Nession top bar, an instructional welcome heading/paragraph/quick prompts and mock inspector/reset controls. The review frame now moves **the complete global mock top bar, welcome/action prompts, protocol inspector and mock caption** to the external `np-fixtures` area; product entry is **only the centered composer**. After one user utterance, the actual conversation body and bottom composer retain their text + UI streaming flow. The contents still use one Text payload, and the parser's validation/error fallback is unchanged.

`index.html` and `product-ia.css` implement the separation; the scenarios are still clickable outside the product and remain bound to the original runtime. No CSS hide-only change is being misrepresented as changing component identity: these elements are physically relocated by the shared review bridge.

**Checks:** `ai-conversation-2254/smoke-test.mjs` passed **17/17** text-protocol parser assertions; the new `ia-smoke.test.mjs` passed **2/2** executable source-structure checks in a V8 evaluator, including the actual external control contract and composer-only product entry. Neither proves browser event dispatch, full streaming, Clipboard, provider integration, trust boundaries, or React/ChatMarkdown integration. Chromium desktop/mobile interaction and published-HTML review remain separate.
