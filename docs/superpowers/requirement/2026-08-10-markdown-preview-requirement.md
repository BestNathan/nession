# Requirements: Markdown File Preview & Content-Based Format Detection

## Background

Nession's web UI currently displays all text files in a CodeMirror editor — including markdown (`.md`) files. While `@codemirror/lang-markdown` provides syntax highlighting, there's no rendered preview. Reading project documentation (README, CHANGELOG, CONTRIBUTING) as raw markdown is noisy and hard to scan. Headings, links, code blocks, and tables lack their visual structure.

Additionally, format detection is purely extension-based (`viewerRegistry.ts`). Files without recognized extensions (e.g., `README`, `CONTRIBUTING`, `Dockerfile`) fall through to plain-text CodeMirror rendering, even when their content is clearly markdown.

This feature adds a rendered markdown preview with preview/raw toggle, and content-based format detection so extensionless files with markdown content are rendered correctly.

**Related code:**
- `FileViewer.tsx` — file content display + toolbar (View/Edit toggle already exists)
- `FileViewerToolbar` — filename, dirty dot, Save, Edit/View toggle, Close
- `viewerRegistry.ts` — extension → viewer type + language key mapping
- `codeMirrorLanguages.ts` — CodeMirror language bundle loading
- `CodeMirrorEditor.tsx` — CodeMirror wrapper component

## Goals

1. **Preview/Raw toggle**: Add a "Preview" / "Raw" toggle button to the `FileViewerToolbar` for markdown files (`.md`, `.markdown`). Preview mode renders formatted markdown; Raw mode shows the CodeMirror editor (current behavior).
2. **Rich markdown rendering**: Rendered preview supports full GFM + extensions:
   - GFM: tables, task lists, strikethrough, autolinks, footnotes
   - Code blocks with syntax highlighting (reuse existing language support)
   - Math (LaTeX via `remark-math` + `rehype-katex`)
   - Mermaid diagrams (via `rehype-mermaid` or equivalent)
   - Emoji shortcodes (`:smile:` → 😄)
   - Definition lists, admonitions/callouts (optional/parkable — nice to have, not v1 blockers)
3. **Content-based format detection**: When a file's extension is missing or unrecognized, scan the first 4KB of content for markdown structural patterns. Use a 3-tier confidence score:
   - **High confidence** (multiple structural patterns found, e.g., headings + lists + links): auto-render preview immediately.
   - **Medium confidence** (some patterns but ambiguous, e.g., a single `#` line that could be a comment): show a suggestion banner "This file looks like Markdown — Preview?" with a one-click switch. User confirms or dismisses.
   - **Low confidence** (no clear markdown patterns): raw mode only, no preview UI shown.
4. **Sanitized output**: All rendered markdown is XSS-safe — HTML in markdown source is escaped or stripped. Use `rehype-sanitize` or equivalent.
5. **Large file handling**: Prefer progressive/virtualized rendering. If not feasible with the chosen library, fall back to same 10MB gate as file loading with preview always available.
6. **No regressions**: Non-markdown files must see zero change in behavior, performance, or UI.

## Non-Goals

- **WYSIWYG markdown editor** — Preview is read-only. Editing happens in Raw (CodeMirror) mode, same as today.
- **Multi-format viewer system** — v1 is markdown only. The architecture should allow adding viewers for other formats later, but only markdown is implemented now.
- **Preview for non-text files** — Images, videos, PDFs already have dedicated viewers. No change.
- **Server-side rendering** — All rendering is client-side. The server continues to serve raw file content.
- **Persistent preferences across sessions** — Toggle state is per-tab within a session. No localStorage persistence in v1.
- **Collaborative preview** — Preview is local to each browser tab.

## Scope

### In Scope

| Item | Details |
|------|---------|
| Preview/Raw toggle button | Added to `FileViewerToolbar`, visible for `.md`/`.markdown` files and extensionless files detected as markdown |
| Markdown rendering | `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex` + mermaid support + syntax highlighting plugin |
| Content-based detection | Scan first 4KB for markdown patterns; confidence scoring |
| Auto/suggest toggle | High confidence → auto-render preview; low confidence → banner suggestion |
| XSS sanitization | `rehype-sanitize` in the render pipeline |
| Large file handling | Progressive/virtualized if feasible; 10MB gate otherwise |
| Syntax highlighting in preview | Code blocks are syntax-highlighted with a theme consistent with Catppuccin Mocha. Language detection reuses existing extension-to-language mappings where possible. |

### Out of Scope

| Item | Reason |
|------|--------|
| Preview for `.rst`, `.adoc`, `.org` | v1 markdown-only |
| Preview for `.json`, `.csv`, `.xml` | Different rendering paradigm; v2 |
| Edit-in-preview mode | Preview is read-only |
| Custom markdown CSS themes | Use existing Catppuccin Mocha palette |
| Print/export rendered markdown | Not a core file-browsing need |

## Constraints

- **Library**: `react-markdown` with GFM + math + mermaid plugins. No new editor dependency (CodeMirror is already present for Raw mode).
- **Detection budget**: Content sniffing reads first 4KB only. Must not add perceptible latency to file open.
- **Bundle size**: Markdown renderer + plugins should not bloat the initial bundle. Consider dynamic import (lazy load the preview renderer).
- **Browser compatibility**: Must work in all modern browsers that Nession currently supports.
- **Existing flow unchanged**: `FileViewer.tsx` logic for media files (image/video/audio/pdf) is untouched. Only the text-file branch gains a new sub-mode.
- **Toggle state scope**: Per-tab, in-memory only. Not persisted to localStorage in v1.

## Success Criteria

1. `.md` and `.markdown` files open with a **Preview** button in the `FileViewerToolbar`. Clicking it renders formatted markdown. The button changes to **Raw** — clicking returns to the CodeMirror editor.
2. Rendered preview correctly displays: headings (h1–h6), bold/italic/strikethrough, links, images, fenced code blocks with syntax highlighting, indented code blocks, ordered/unordered lists, nested lists, task lists, blockquotes, horizontal rules, tables, autolinks, footnotes.
3. LaTeX math (`$inline$` and `$$block$$`) renders correctly.
4. Mermaid diagrams in ` ```mermaid` blocks render as SVG diagrams.
5. Emoji shortcodes (`:rocket:`, `:warning:`) render as unicode emoji.
6. Content-based detection correctly identifies markdown in extensionless files (e.g., `README`, `CONTRIBUTING`, `CHANGELOG`) with ≥95% accuracy. Evaluation set: a representative sample of 50-100 extensionless markdown docs from common open-source repos + 20-30 non-markdown files with superficially markdown-like content (shell scripts, Python files, plaintext notes).
7. Files with markdown-like patterns that are NOT markdown (e.g., shell scripts with `#` comments, Python files) are NOT falsely detected — the confidence threshold prevents false positives.
8. Detection for ambiguous files shows a suggestion banner: "This file may be Markdown — [Preview]" rather than auto-rendering.
9. HTML in markdown source is sanitized — `<script>`, `<iframe>`, `onclick` handlers are stripped.
10. Large file handling:
    - If progressive/virtualized rendering is feasible: opening a 10MB markdown file renders the first screenful in <500ms, scrolling is smooth (no jank).
    - If fallback (no progressive rendering): preview is available for all files up to the 10MB gate. Files >1MB show a loading indicator during initial render. The browser tab must not freeze (render must be interruptible/cancellable on tab close).
11. All existing tests pass (`npm test`, `cargo test`). New tests cover: preview rendering output, content detection logic, toggle state transitions, sanitization, edge cases.
12. Non-markdown text files (`.txt`, `.json`, `.py`, `.rs`, etc.) open exactly as they do today — no new UI elements, no behavior change.

## Edge Cases

| Case | Expected Behavior |
|------|-------------------|
| Empty file (0 bytes) | Opens in Raw mode with empty editor. No Preview button (nothing to render). |
| File with only YAML frontmatter (`---\n...\n---`) and no body | Detection: low confidence (looks like markdown metadata but no content). Shows suggestion banner, not auto-render. |
| Single-line file (`# Hello`) | Detection: medium confidence (single `#` could be a shell comment or markdown heading). Shows suggestion banner, not auto-render. |
| Binary file with no extension | Content detection should bail early if first 4KB contains null bytes or non-UTF8 sequences. Treat as unsupported binary. |
| UTF-8 BOM at start of file | Detection skips BOM before pattern matching. Preview renders correctly. |
| Markdown with embedded HTML | HTML is sanitized. Safe tags (`<details>`, `<summary>`, `<kbd>`) may be allowed; scripts and event handlers are stripped. |
| Very long single line (no newlines, e.g., minified text) | Detection reads first 4KB. Preview renders as single paragraph. |
| Multiple markdown tabs open simultaneously | Each tab has independent preview/raw state. |
| Toggle while file is dirty (unsaved edits in Raw mode) | Preview always renders the saved (server) version to avoid confusion. Show a note: "Preview shows saved version. Save to update preview." |
| File save while in Preview mode | Save succeeds (writes Raw content). Preview does NOT auto-refresh — user must toggle Raw→Preview to see updated render. |
| Network error during file load | Same error handling as current `FileViewer` — error state with retry. |
| Mobile/responsive viewport | Preview layout adapts — code blocks scroll horizontally, tables scroll if overflow. Toggle is an icon-only button on small screens. |
| Markdown with malicious content | Sanitizer strips `<script>`, `<iframe>`, `javascript:` URLs, event handlers. Safe. |
| File renamed from `.txt` to `.md` while open | Tab updates extension → detection re-runs → Preview button appears. |
| Confidence score exactly at a tier boundary | Err toward the more conservative tier: high↔medium boundary → suggestion; medium↔low boundary → raw only. |

## Open Questions

1. **Mermaid rendering approach**: `rehype-mermaid` vs custom `code` block handler. `rehype-mermaid` runs mermaid CLI in browser via WASM — investigate bundle size impact.
2. **Progressive rendering feasibility**: `react-markdown` doesn't natively stream. Virtualization via `react-window` or chunked rendering may be needed for large files. Spike before committing.
3. **KaTeX CSS**: `rehype-katex` requires a KaTeX CSS file. Can we scope it to the preview pane only (avoid polluting global styles)?

---
**Status:** Draft
**Created:** 2026-08-10
**Author:** Nathan
