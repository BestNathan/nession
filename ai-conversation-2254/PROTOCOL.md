# Nession UI Protocol v1 — Text-only Component Directives

**Owner:** [Requirement #2254](https://github.com/BestNathan/nession/issues/2254). **Status:** interactive mock design, not a production runtime or new provider message protocol. **JSON Schema:** [schema.v1.json](schema.v1.json).

## 1. Fundamental constraint

Both user and assistant messages stay exactly Text Content: { "type": "text", "text": "..." }. No new message content type, provider wire format, ReactNode, or arbitrary generated HTML/JS. Text contains prose plus dedicated fenced UI directives; the Content Engine interprets them at presentation time. Distinct from #2221 System One Scenes, this issue owns System Two in-conversation placement, re-use and serialization.

## 2. Fenced JSON syntax

One complete fenced Markdown code block with language tag exactly nession-ui; body is one strict JSON object. Examples:

```nession-ui
{
  "v": 1,
  "op": "render",
  "component": "agent.list",
  "input": {"status":"online"}
}
```

```nession-ui
{
  "v": 1,
  "op": "reference",
  "component": "agent.list",
  "ref": "cmp_001",
  "context": {"selectedAgentId":"beijing"}
}
```

The first requests a registered interactive view; the second points to an existing scoped instance and carries a **non-authoritative historical context snapshot**. Component and ref are not authentication tokens. User- and assistant-authored Text are parsed identically. Other fences, quoted examples and prose remain ordinary content.

V1 envelope fields:
- Render: v=1, op=render, required component, optional input object; no other fields.
- Reference: v=1, op=reference, required component and nonempty ref, optional context object; no other fields.
- Fixed outer JSON Schema with additionalProperties=false. Registered component-specific versioned schemas validate input and context separately.
- V1 deliberately omits execute, patch, update, remove, layout, arbitrary CSS, React props, JS callbacks or state injection. A render directive never automatically performs a business mutation.

## 3. Component registry (proposed, not shipped)

| Component ID | Public inputs | Canonical implementation owner |
|---|---|---|
| agent.list | status=all/online/offline | AgentsPlugin + Agent list view |
| agent.detail | agentId | AgentDetail |
| session.list | agentId?, status? | SessionsPlugin + SessionList |
| session.detail | sessionId | SessionDetails |
| session.create.form | agentId?, name?, workingDir? | CreateSessionDialog + SessionsPlugin |
| terminal.session | sessionId | Terminal runtime; dedicated active-input and size policy |
| git.changes | sessionId | GitPlugin + GitWorkspace; read-only |
| git.diff | sessionId, path | GitDiffView |
| files.browser | agentId, path | FilesPlugin + FileBrowser |
| env.files | scope | EnvPlugin; restricted/redacted |
| claude-code.conversation | agentId, sessionId | Existing AIConversationAdapter |

An AI Component is a **semantic adapter**, not the unrestricted React Props object. It publishes input schema, view binding, scoped instance identity, bounded model-facing state, and current permitted actions. It delegates data/mutations to existing domain owners, never creating a parallel Agent/Session/Terminal store.

## 4. Parse/stream semantics

1. Split Text into ordinary content and whole fenced nession-ui directives. Nested code examples or quoted literal samples are never executed.
2. Hold an incomplete UI block as a pending non-executable segment. Never mount a partial JSON object.
3. After complete close fence: parse JSON, validate envelope, component schema, ref scope and current permissions. Render only a registered view. Invalid schema, unsupported version, unknown component, stale ref and malformed JSON become visible safe fallbacks with source access, never silent drops.
4. Stable placement key is conversation/message/block identity; instance identity is different. New text appended to an active stream must not remount previously settled views or lose focus/scroll anchors. History replay is purely presentational and cannot repeat a mutation.
5. Preserve the existing shared Conversation Turn/Process/Tool anatomy, MessageScroller history behavior and ChatMarkdown implementation for non-directive spans.

**Prototype parser limitation:** content-parser.mjs is a small incremental fence scanner for testing product interaction, not a complete CommonMark implementation. Production should integrate with the existing incremental mdast pipeline for nested/escaped fence contexts, authoring escapes, partial streaming and long-content performance.

## 5. Component instance / reference lifecycle

- Definition = registered name, such as agent.list.
- Instance = scoped runtime state, selected target, draft, and action projection.
- Placement = one occurrence of the view in one text message.

Several placements may reference the same instance, without trying to move the same DOM tree. Removing a placement or conversation does not delete a real Session. Terminal references require a single active controller/mount and previews or handoffs elsewhere.

Component -> Text serialization returns a fenced reference with bounded historical context, suitable for user messages and model context. Live state/action authoritativeness still belongs to the existing business APIs and permission checks, not a model output or old snapshot. Available actions are recomputed when executing.

## 6. Safety and product principles

- Render = show a capability; submitting any business mutation requires explicit user action and canonical validation. No tool execution from text.
- HTML in Text remains ordinary sanitized Markdown/text; no script injection or untrusted arbitrary HTML.
- User starts with empty conversation and composer. Model controls **which registered business capability emerges**, not CSS, layout or tool power.
- System One (#2221) may use a different bounded action/context projection and Scene presentation but shares canonical resource APIs, never a coupled Scene-to-message identity.
- Respect Nession design doctrine: assistant reading column, bounded user bubble, subdued tool activity, progressive disclosure, responsive width and deterministic focus.

## 7. Mock walkthrough

Open [index.html](index.html). Start from empty conversation, choose **查看 Agent**; watch assistant Text stream and an Agent-list component appear. Select Beijing and **发给 AI**: a user text message carries a JSON reference, and the assistant shows a Session creation form. Explicitly submit, inspect the mock new Session, and ask **再看之前组件** for another placement of the same instance. Inspector exposes raw Text, parsed segments, live state/actions and mock events. **异常演示** shows invalid directive fallback. **重置** clears mock UI only.

Run parser-only tests with: node ai-conversation-2254/smoke-test.mjs

The standalone HTML and JS use local fixture data, local simulated model decisions and a fake Session create. No backend, actual AI, live git, production Schema validator, Chromium acceptance or genuine API authority is claimed.
