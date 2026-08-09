# File Viewer Enhancement — Design Spec

**Date:** 2026-08-09
**Branch:** (new)

## Overview

Refactor `FileViewer` into an extension-routed viewer system that dispatches to the appropriate viewer component based on file extension. Add image, video, audio, and PDF viewers. Switch CodeMirror language packages to lazy loading with directory-level preloading. Enforce a consistent 10MB size limit front-to-back.

## Goals

1. **Multi-format viewing** — images (png, jpg, jpeg, gif, svg, webp, bmp, ico), video (mp4, webm, mov), audio (mp3, wav, ogg, flac, aac), PDF
2. **Lazy syntax highlighting** — preload language packages when directory listing arrives; synchronous retrieval when file opens
3. **Hard 10MB size limit** — frontend gate in FileBrowser, backend gate unchanged; remove the current 1MB soft-warning dialog
4. **Unsupported format placeholder** — unified "Preview not supported" for non-viewable extensions; no download option
5. **Extended language support** — shell, Go, Rust, C/C++, TOML, XML, SQL, Dockerfile, Java, Ruby

## Architecture

```
TerminalView.tsx
  └── TerminalLayout.tsx (breakpoint router)
        ├── FileTabs.tsx (desktop ≥1024px)
        │     └── FileViewer.tsx ──ext──▶  viewer dispatch
        └── MobileTerminalLayout.tsx (mobile <1024px)
              └── FilesPanel
                    └── FileViewer.tsx ──ext──▶  same dispatch

FileViewer.tsx (entry point — extension routing, delegates to sub-viewers)
  │
  ├── 1. Parse extension from path
  ├── 2. Lookup viewerRegistry[ext] → viewerType
  ├── 3. If null → render UnsupportedView immediately (no fetch)
  ├── 4. Fetch file content via fileOps.readFile(path)
  ├── 5. Decode base64 → text or blob URL per viewerType
  └── 6. Delegate to matched viewer component

FileBrowser.tsx (size gate + preload trigger)
  ├── on file click: entry.size > 10MB → toast + no-op
  ├── on file click: entry.size ≤ 10MB → openFile(path)
  └── on directory listing: preload() language packages for visible extensions
```

### File tree

```
web/src/
├── components/
│   ├── FileViewer.tsx              # Rewrite: routing entry point
│   ├── ImageViewer.tsx             # New
│   ├── VideoViewer.tsx             # New
│   ├── AudioViewer.tsx             # New
│   ├── PdfViewer.tsx               # New
│   ├── UnsupportedView.tsx         # New
│   ├── CodeMirrorEditor.tsx        # Enhance: lazy language loading
│   └── FileBrowser.tsx             # Light: 10MB gate + preload call
├── lib/
│   ├── codeMirrorLanguages.ts      # Rewrite: lazy loaders + preload()
│   └── viewerRegistry.ts           # New: extension mappings
```

### Extension → viewer mapping

```ts
// lib/viewerRegistry.ts
const EXT_VIEWER_MAP: Record<string, ViewerType> = {
  // Images
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  svg: 'image', webp: 'image', bmp: 'image', ico: 'image',
  // Video
  mp4: 'video', webm: 'video', mov: 'video',
  // Audio
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio',
  // PDF
  pdf: 'pdf',
};

// Extension → CodeMirror language key
const EXT_LANG_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', json: 'json', yaml: 'yaml', yml: 'yaml',
  md: 'markdown', html: 'html', css: 'css',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  go: 'go', rs: 'rust', c: 'cpp', cpp: 'cpp', h: 'cpp', hpp: 'cpp',
  sql: 'sql', xml: 'xml', toml: 'toml',
  dockerfile: 'dockerfile', java: 'java', rb: 'ruby',
};
```

### Lazy language loading

```ts
// lib/codeMirrorLanguages.ts
const LOADERS: Record<string, () => Promise<LanguageSupport>> = {
  shell:    () => import('@codemirror/lang-shell').then(m => m.shell()),
  go:       () => import('@codemirror/lang-go').then(m => m.go()),
  rust:     () => import('@codemirror/lang-rust').then(m => m.rust()),
  cpp:      () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  sql:      () => import('@codemirror/lang-sql').then(m => m.sql()),
  xml:      () => import('@codemirror/lang-xml').then(m => m.xml()),
  // ... existing: javascript, typescript, python, json, yaml, markdown, html, css
};

const loaded = new Map<string, LanguageSupport>();
const failed = new Set<string>();

export function preload(exts: string[]): void {
  for (const ext of exts) {
    const langKey = EXT_LANG_MAP[ext];
    if (!langKey || loaded.has(langKey) || failed.has(langKey)) continue;
    const loader = LOADERS[langKey];
    if (loader) {
      loader()
        .then(lang => loaded.set(langKey, lang))
        .catch(() => failed.add(langKey));
    }
  }
}

export function getLanguage(ext: string): LanguageSupport | undefined {
  const langKey = EXT_LANG_MAP[ext];
  return langKey ? loaded.get(langKey) : undefined;
}
```

- **Preload timing:** `FileBrowser.tsx` calls `preload(exts)` after each directory listing
- **Get timing:** `CodeMirrorEditor.tsx` calls `getLanguage(ext)` synchronously when file opens
- **Fallback:** if language not yet loaded (race), render plain text; retry on next render
- **Failure:** failed imports are tracked — don't retry; render plain text

## Component Details

### FileViewer.tsx — Rewrite

Entry point that decides which sub-viewer to render. No longer renders CodeMirror directly.

- Props: `path`, `fileOps`, `readOnly`, `onDirtyChange`, `onClose`
- State: `content`, `loading`, `error`, `viewerType`
- Flow: mount → lookup viewerType → if null, UnsupportedView; else fetch → decode → delegate
- Toolbar: Edit/View toggle + Save + Close for text files; Close only for media and unsupported

### ImageViewer.tsx — New

- Receives decoded content as a Blob URL
- `<img>` with `overflow: auto`, zoom via `transform: scale()`, fit-to-screen toggle
- Blob URL created on mount, revoked on unmount
- SVG renders inline via `<img>` (browser handles SVG natively)

### VideoViewer.tsx — New

- Native `<video controls>` with blob URL
- Full-width, native playback controls (play, pause, seek, volume, fullscreen)

### AudioViewer.tsx — New

- Native `<audio controls>` with blob URL
- Centered layout, full-width controls bar

### PdfViewer.tsx — New

- `<embed src={blobUrl} type="application/pdf">` full-width and full-height
- Fallback message if browser doesn't support embedded PDF
- Blob URL revoked on unmount

### UnsupportedView.tsx — New

- Centered icon + "Preview not supported" message
- Shows filename and extension for context
- No download or raw-view option

### CodeMirrorEditor.tsx — Enhance

- Replace static `getLanguageExtensions()` with `getLanguage(ext)` from `codeMirrorLanguages.ts`
- If language not loaded → plain text, retry on next render
- New languages added: shell, Go, Rust, C/C++, SQL, XML (via lazy `import()`)

### FileBrowser.tsx — Light changes

- Add 10MB gate: `if (entry.size > 10 * 1024 * 1024)` → toast + return
- Remove 1MB soft-warning dialog and associated hook state
- Add `preload(exts)` call after directory listing render

## Data Flow

### File open → render

```
User clicks file in FileBrowser
  │
  ├── size > 10MB? → toast "File too large (>10MB)" + return
  ├── size ≤ 10MB? → openFile(path)
  │
  ├── FileViewer mounts
  │   ├── viewerType = viewerRegistry[ext]
  │   ├── viewerType === null → UnsupportedView (no fetch)
  │   └── viewerType !== null → fileOps.readFile(path)
  │       ├── Success → decode base64, route to viewer
  │       └── Error → error state per error type
  │
  └── Viewer renders
```

### Media content delivery

```
readFile returns { content: base64, mime_type }

Text files: atob → TextDecoder → UTF-8 string → CodeMirror
Media files: atob → Uint8Array → Blob → URL.createObjectURL → native element
  → URL.revokeObjectURL on unmount
```

### Language preload

```
FileBrowser receives directory listing
  │
  ├── Extract all unique extensions from entries
  ├── Filter against EXT_LANG_MAP keys
  ├── For each: preload(langKey)
  │   ├── Already loaded/failed → skip
  │   └── import('@codemirror/lang-xxx') → store on success, mark failed on error
  │
  └── later: getLanguage(ext) → synchronous cache hit
```

## Error States

| State | Trigger | UI |
|-------|---------|-----|
| Too large (frontend) | `entry.size > 10MB` | Toast, file doesn't open |
| Too large (backend) | `file_too_large` error | Centered message in viewer |
| Not found | `not_found` error | Centered message in viewer |
| Permission denied | `permission` error | Centered message in viewer |
| Load failed | Network/decode error | Centered message + retry button |
| Unsupported format | Extension not in registry | UnsupportedView |
| PDF not supported | `<embed>` load failure | Fallback message |
| Language load failed | `import()` rejection | Plain text, no highlight |
| Loading | Fetch in progress | Skeleton/spinner |

## Size Limit

- Backend: `MAX_READ_SIZE = 10MB` (unchanged, `crates/nession-agent/src/fs/ops.rs`)
- Frontend: 10MB gate in `FileBrowser.tsx` before calling `openFile()`
- Remove: current 1MB soft-warning dialog (`useFileBrowserDialogs.ts` large-file state)
- Both ends agree: files > 10MB are not viewable

## New npm packages

```bash
npm install \
  @codemirror/lang-shell \
  @codemirror/lang-go \
  @codemirror/lang-rust \
  @codemirror/lang-cpp \
  @codemirror/lang-sql \
  @codemirror/lang-xml
```

No other new dependencies. All media viewers use native browser elements.

## Non-Goals

- No streaming/chunked reads — entire file loaded in one fetch
- No file download/export
- No archive browsing (zip, tar, gz, etc.)
- No hex viewer for binary files
- No mobile-specific media viewer variants
- No CodeMirror editor extensions (VSCode keymap, etc.)
- No edit mode for non-text files
- No TOML/Dockerfile dedicated CodeMirror packages (render as plain text with basic highlighting via existing modes)

## Testing

### Unit tests (Vitest)

| Target | Coverage |
|--------|----------|
| `viewerRegistry.ts` | Known extensions → expected viewer type; unknown → null |
| `codeMirrorLanguages.ts` | preload populates cache; getLanguage sync retrieval; failed import tracking |
| `FileViewer.tsx` | Renders correct sub-viewer per extension; UnsupportedView for null; error states; loading state |
| `ImageViewer.tsx` | `<img>` with blob URL; zoom controls; fit-to-screen toggle |
| `VideoViewer.tsx` | `<video controls>` with blob URL |
| `AudioViewer.tsx` | `<audio controls>` with blob URL |
| `UnsupportedView.tsx` | Icon + message + filename |
| `FileBrowser.tsx` | 10MB gate blocks open; preload called with directory extensions |

### Existing test updates

- `FileViewer.test.tsx`, `CodeMirrorEditor.test.tsx`, `FileBrowser.test.tsx` — update assertions for new behavior
- Coverage threshold: 80% (unchanged)
