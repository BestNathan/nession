# Claude Code Transcript Raw Records — interactive prototype (#3726)

Owner: https://github.com/BestNathan/nession/issues/3726
Related: #1234 historical canonical projection (superseded for raw Transcript), #3606 polling preservation, #1199 JSON/JSONL primitives, #3600 Claude MCP, #2689 Claude Memory.
Entry: index.html · Static styles.css · Fixture/application app.js

## Design question and approved decision (2026-11-16)

The transcript is a **complete raw-record browser**. Every JSONL line has exactly one visible timeline row regardless of recognized kind or malformed JSON. A recognized kind uses a native row icon/visual grammar and useful preview; unknown types get a generic row with native \`type\` / \`subtype\` text. **Do not display parser-status badges** (“已识别”, “未识别”). Every row expands meaningful detail and independently offers **Raw**, with JSON tree + original text when valid and original text when invalid. A tool result is not consumed by an adjacent tool call. A record with many content blocks displays those as sub-blocks within one row in production (the mock previews the first relevant block).

## IA and fidelity baseline

- **Web owner tree:** WebLayout → Sidebar (Agents/Sessions) + ShellMain → WorkspacePanel → WorkspaceShell → Claude Code → Transcripts list + timeline → independent Raw inspector. The prototype draws a simplified Web sidebar and a Claude-capability crop with the existing capability tabs, not a new product navigation owner.
- **App owner tree:** AppLayers → WorkspacePanel / host-owned AppPageHeader (single Back) → WorkspaceShell → Claude Code → Transcripts list → timeline → Raw full-width pushed depth. No desktop sidebar inside App. The 390/375 device changes actual internal composition.
- **Main source references:** \`web/src/capabilities/claude-code/components/{ClaudeCodeWorkspace,TranscriptView,TranscriptTimeline}.tsx\`, \`web/src/capabilities/claude-code/hooks/useTranscriptItems.ts\`, \`web/src/components/json/JsonTree.tsx\`, \`docs/design/workspace.md\`, \`design/generated/web.css\`; shared prototype frame \`../prototype-frame-2758/{frame.css,frame.js}\`. Current source uses a Rust canonical projection; this prototype intentionally depicts a **candidate new raw transport/frontend display contract**, not shipped behavior.
- **Visual baseline:** simplified snapshot of shared Nession semantic color roles, type hierarchy and scroll ownership from the code above. No actual product pixel comparison or real browser acceptance has yet been performed.

## Critical interactive path

1. Open primary Transcript. The latest page includes an assistant message, system event, attachment, metadata, unknown \`new-runtime-diagnostic\`, malformed JSON and 25-KB-like tool result. No parser-status badges are shown; all visible rows have independent Raw buttons.
2. Click any row, including system/unknown/invalid. Detail appears within that row. Click **Raw**; inspect JSON tree, then **原始文本**, then **复制**. Invalid JSON goes straight to raw text; large raw content is not truncated.
3. Click **加载更早记录** to reveal user, assistant thinking, Bash tool-use and user tool-result as distinct rows. Each line remains accessible, including tool result; new record addition does not remove the older page.
4. Choose the subagent Transcript; only its records appear. Return to primary; selection and Raw do not leak across identities.
5. In the external reviewer controls, append a new \`future-run-status\` unknown record, then switch Session. Verify the previous Raw inspector and record selection are cleared.
6. Change the external size control Web 1180 → App 390 → App 375 → Web 1024. App shows list → timeline → Raw navigation with a single header Back; Web shows concurrent list/timeline and right-side Raw inspector.

## Fixture boundaries, negative states and non-goals

- All records are **static/in-memory mock JSONL**, including a deliberately malformed record, one long record, a synthetic unknown upstream type, and synthetic primary/subagent identity. No real Claude schema package is imported in the static prototype. Production front end should reuse suitable open-source TS/Zod definitions with an explicit unknown fallback and no strict closed-union data loss.
- The 7-record initial page and 'load older' control demonstrate visible paging; every record is visible once its page is loaded, and no record is filtered by parsing. Backend auth, generation guard, byte-offset cursor, incomplete-tail, oversize chunks and transport are **not implemented by this mock**.
- The copy control needs a secure browser clipboard context; if unavailable it falls back to text selection rather than claiming copy success.
- External test controls live outside product viewport. No real network, Session mutation, tool execution, filesystem changes, credentials, or cross-Agent reads.
- Product states intentionally not modeled in this compact flow: loading, disconnected Agent and denied transcript; production Issue SC still requires them.
- This is a design candidate/prototype, **not** production implementation, CI/Playwright proof, exact Web/App fidelity, or Pages deployment evidence. Static smoke exists separately.

## Publication

Shared history-isolated \`prototype\` branch only; directory \`claude-transcript-3726/\`. Link the exact resulting commit SHA from Issue #3726 after publication and update the branch-root README/gallery. Public preview expected at https://bestnathan.github.io/nession/prototypes/claude-transcript-3726/index.html but **NOT verified published** until public \`prototypes/manifest.json\` exact SHA and HTTPS HTML readback confirm freshness.
