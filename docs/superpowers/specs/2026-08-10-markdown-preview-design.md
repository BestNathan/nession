# Design Spec: Markdown File Preview & Content-Based Format Detection

## Overview

Add markdown preview rendering and content-based format detection to the Nession web file viewer. Markdown files (`.md`, `.markdown`, and extensionless files detected as markdown) get a Preview/Raw toggle alongside the existing Edit/View toggle. A new `MarkdownPreview` component renders full GFM + LaTeX math + emoji shortcodes. A new `contentDetector` module scans the first 4KB of extensionless files to identify markdown content via pattern matching with 3-tier confidence scoring.

**Requirements:** [#195](https://github.com/BestNathan/nession/issues/195)

## Architecture

```
FileViewer.tsx (modified)
├── FileViewerToolbar (modified — new Preview/Raw button)
│   ├── filename + dirty dot
│   ├── Save (text only, when raw + editing)
│   ├── [Preview | Raw] toggle  ← NEW (markdown only)
│   ├── [Edit | View] toggle    ← existing (text only; hidden in preview mode)
│   └── ✕ Close
└── FileViewerContent (modified — new markdown branch)
    ├── markdown + preview mode → MarkdownPreview (NEW)
    ├── markdown + raw mode     → CodeMirrorEditor
    ├── image/video/audio/pdf   → MediaViewer (unchanged)
    └── other text              → CodeMirrorEditor (unchanged)

New files:
  web/src/components/MarkdownPreview.tsx   — rendered markdown component
  web/src/lib/contentDetector.ts           — content-based format detection
```

**Key principle:** Markdown is a separate viewer type (`'markdown'`) with its own content branch. It shares the text save/edit infrastructure but has its own render path for preview.

## Data Flow

### File Open Flow

```
File opened
  │
  ├─ Extension is .md/.markdown?
  │    └─ yes → viewerType = 'markdown', isMarkdown = true, default to preview
  │
  └─ Extension empty/unknown?
       │
       ├─ Load file content (base64 → UTF-8)
       ├─ Run detectMarkdown(first 4KB) in parallel
       │
       ├─ High confidence (≥3 patterns)  → viewerType = 'markdown', auto-show preview
       ├─ Medium confidence (1-2 patterns) → viewerType = 'markdown', show suggestion banner, show raw
       └─ Low confidence (0 patterns)    → viewerType = null (plain text, no preview UI)
```

### Toggle State Machine

```
                    ┌──────────┐
         open .md → │ PREVIEW  │ ← high confidence detection
                    └────┬─────┘
                    [Raw] │
                    ┌────▼─────┐
                    │ RAW VIEW │ ← open with medium confidence (banner shown)
                    └────┬─────┘
                   [Edit] │
                    ┌────▼─────┐
                    │ RAW EDIT │
                    └────┬─────┘
                   [View] │
                    ┌────▼─────┘
                    │ RAW VIEW
                    └──────────┘

From any raw state: [Preview] → PREVIEW
From PREVIEW: [Raw] → RAW VIEW (always view-only first)
```

## Components

### FileViewer.tsx (Modified)

**New state:**
- `isMarkdown: boolean` — true when file is markdown (by extension or detection)
- `viewMode: 'preview' | 'raw'` — current display mode
- `showSuggestion: boolean` — whether the detection suggestion banner is visible

**New logic in `loadFile()`:**
After loading text content, if `ext` is empty (no extension), run `detectMarkdown(content.slice(0, 4096))`. If confidence is high or medium, set `isMarkdown = true` and `viewMode` accordingly. If medium, also set `showSuggestion = true`.

**Modified `FileViewerToolbar` props:**
Add `isMarkdown`, `viewMode`, `onPreviewToggle`, `onSuggestionDismiss`.

**Modified `FileViewerContent` props:**
Add `isMarkdown`, `viewMode`.

### FileViewerToolbar (Modified)

**Button visibility matrix:**

| File type / state | Save | Preview/Raw | Edit/View | Close |
|-------------------|------|-------------|-----------|-------|
| Markdown, preview | — | [Raw] | — | ✕ |
| Markdown, raw view | Save* | [Preview] | [Edit] | ✕ |
| Markdown, raw edit | Save | [Preview] | [View] | ✕ |
| Text, view | — | — | [Edit] | ✕ |
| Text, edit | Save | — | [View] | ✕ |
| Media | — | — | — | ✕ |

*Save button shown but disabled when not dirty; hidden entirely in preview mode.

**Preview/Raw button:** Uses `Eye`/`Code` icons from lucide-react.

### MarkdownPreview.tsx (New)

```tsx
interface MarkdownPreviewProps {
  content: string;
  filename: string;
}
```

**Rendering pipeline:**
```
raw markdown text
  → remark-parse
  → remark-gfm (GFM: tables, task lists, strikethrough)
  → remark-math (LaTeX math detection)
  → rehype-highlight (code block syntax highlighting)
  → rehype-katex (render math to HTML)
  → rehype-sanitize (strip XSS, allow safe tags)
  → react-markdown (render to React elements)
```

**Styling:**
- Container: `overflow-y-auto` with padding, Catppuccin Mocha background/text colors
- Headings: appropriate sizes (h1–h6)
- Code blocks: highlight.js Catppuccin Mocha theme CSS
- Tables: bordered, striped rows
- Blockquotes: left border accent
- KaTeX: scoped CSS import (no global pollution)

**Error boundary:** Wrapped in a React error boundary. On render failure, shows:
> "Preview unavailable — [Show raw]" with a button that calls `onFallbackToRaw`.

**Large files:** If content > 1MB, show a non-blocking banner "Large file — rendering may be slow" above the preview.

### contentDetector.ts (New)

```tsx
export type Confidence = 'high' | 'medium' | 'low';

export interface DetectionResult {
  confidence: Confidence;
  found: string[];  // names of matched patterns, for debugging
}

export function detectMarkdown(content: string): DetectionResult;
```

**Detection patterns (each = 1 point toward confidence):**

| # | Pattern | Check |
|---|---------|-------|
| 1 | ATX heading | `^#{1,6}\s` on any line |
| 2 | Setext heading | `^(=+|-+)\s*$` on a line |
| 3 | Unordered list | `^[\*\-\+]\s` on any line |
| 4 | Ordered list | `^\d+\.\s` on any line |
| 5 | Fenced code block | `` ^``` `` on any line |
| 6 | Link | `\[.*\]\(.*\)` anywhere |
| 7 | Bold/italic | `\*\*` or `__` or `\*[^*]` or `_[^_]` |
| 8 | Blockquote | `^>\s` on any line |
| 9 | Table | `^\|.*\|.*\|$` on any line |
| 10 | Horizontal rule | `^(\-{3,}|\*{3,}|\_{3,})\s*$` |

**Thresholds:** ≥3 patterns → `'high'`, 1-2 → `'medium'`, 0 → `'low'`.

**Short-circuit:** If content starts with null bytes or contains >10% non-printable characters, return `{ confidence: 'low', found: [] }` immediately.

**Scan limit:** Only first 4096 bytes.

### viewerRegistry.ts (Modified)

Add `'markdown'` to `ViewerType`:
```tsx
export type ViewerType = 'image' | 'video' | 'audio' | 'pdf' | 'markdown';
```

Add `isMarkdownExt(ext: string): boolean` — returns true for `md`, `markdown`.

### Suggestion Banner (medium confidence)

Rendered inside `FileViewerContent` when `showSuggestion` is true, above the CodeMirror editor:

```
┌──────────────────────────────────────────────────┐
│ ℹ️ This file looks like Markdown  [Preview]  [✕] │
└──────────────────────────────────────────────────┘
```

- Uses `Info` icon from lucide-react
- Banner is `bg-blue-950/50 border border-blue-800` (Catppuccin Mocha blue tones)
- `[Preview]` sets `viewMode = 'preview'`, hides banner
- `[✕]` dismisses permanently (`showSuggestion = false`)
- If user toggles preview → raw, banner does NOT reappear

## Dirty State & Preview Interaction

- Preview always renders the **server version** of the file (`originalContent`), not `content` (which may be dirty from raw edits).
- If `isDirty` and user switches to preview, show a note below the toolbar:
  > "*Preview shows the saved version. Save to update preview.*"
- Saving in raw mode does NOT auto-refresh the preview. User must toggle Raw → Preview to re-render.
- Close-with-unsaved-changes dialog (`AlertDialog`) works identically for markdown files as for other text files.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `react-markdown` render throws | Error boundary catches → "Preview unavailable — [Show raw]" button → switches to raw mode |
| KaTeX render failure for a math block | Show raw LaTeX source in a styled code block instead of rendered math |
| Content detection takes >500ms | Timeout → treat as low confidence, no preview |
| File content is binary (null bytes) | Detection short-circuits → low confidence → raw editor |
| Network error during load | Same as current `FileViewer` error state (unchanged) |
| File >10MB | Blocked by existing 10MB gate in `FileBrowser.handleEntryClick` (unchanged) |

## Dependencies

Add to `web/package.json`:

| Package | Version | Purpose |
|---------|---------|---------|
| `react-markdown` | `^9.0` | Markdown → React rendering |
| `remark-gfm` | `^4.0` | GFM tables, task lists, strikethrough |
| `rehype-highlight` | `^7.0` | Code block syntax highlighting |
| `rehype-sanitize` | `^6.0` | XSS sanitization |
| `remark-math` | `^6.0` | LaTeX math plugin |
| `rehype-katex` | `^7.0` | Render math to HTML |

No new dependency for mermaid — v1 defers mermaid rendering. If needed, add `rehype-mermaid` in a follow-up.

Dev-only: `@types/hast` for rehype types if needed.

## File Changes

| File | Action | Lines (est.) |
|------|--------|-------------|
| `web/package.json` | Add 6 dependencies | +6 |
| `web/src/lib/viewerRegistry.ts` | Add `'markdown'` to type, export `isMarkdownExt()` | +5 |
| `web/src/lib/contentDetector.ts` | **New** — detection logic + tests | ~80 |
| `web/src/components/MarkdownPreview.tsx` | **New** — preview component + error boundary | ~150 |
| `web/src/components/FileViewer.tsx` | Add viewMode state, markdown branch, toolbar button, banner, detection flow | ~80 |
| `web/src/components/__tests__/MarkdownPreview.test.tsx` | **New** — rendering tests | ~80 |
| `web/src/lib/__tests__/contentDetector.test.ts` | **New** — detection unit tests | ~100 |
| `web/src/components/__tests__/FileViewer.test.tsx` | Extend — markdown branch tests | ~60 |

## Testing Strategy

### Unit Tests (Vitest)

**contentDetector.test.ts:**
- High confidence: README-style content with headings + lists + links → `{ confidence: 'high', found: [...] }`
- Medium confidence: shell script with `#` comments (heading pattern only) → `{ confidence: 'medium' }`
- Low confidence: plain text with no markdown patterns → `{ confidence: 'low' }`
- Binary content short-circuit → `{ confidence: 'low' }`
- Empty content → `{ confidence: 'low' }`
- Single-line markdown (`# Hello`) → medium or high
- Content with only fenced code block → medium
- 4KB boundary: detection only scans first 4096 bytes

**MarkdownPreview.test.tsx:**
- Renders headings, paragraphs, bold, italic
- Renders fenced code blocks with language class
- Renders tables
- Renders task lists (checked/unchecked)
- Renders LaTeX math inline and block
- Sanitizes HTML (script tags stripped)
- Error boundary fallback on malformed input
- Large file banner when content >1MB

**FileViewer.test.tsx (extended):**
- `.md` file shows Preview/Raw toggle
- `.txt` file does NOT show Preview/Raw toggle
- Extensionless file with markdown content: auto-detects and shows preview
- Toggle Preview → Raw → Preview retains content
- Dirty state note shown when switching to preview with unsaved edits
- Close with unsaved changes shows dialog (unchanged behavior)

### Integration / Manual

- Open a real `.md` file → verify rendered preview matches expected output
- Open a `README` (no extension) with markdown content → verify auto-detection
- Edit in raw mode, make dirty, toggle to preview → verify "saved version" note
- Open a `.sh` script → verify NO preview button appears
- Open a 5MB markdown file → verify no tab freeze

---
**Status:** Draft
**Created:** 2026-08-10
**Requirements:** [#195](https://github.com/BestNathan/nession/issues/195)
