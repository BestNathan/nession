# File Viewer Enhancement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor FileViewer into an extension-routed viewer system with image/video/audio/PDF support, lazy CodeMirror language loading, and a hard 10MB size limit.

**Architecture:** Extension-based dispatch via `viewerRegistry.ts`. `FileViewer.tsx` becomes a routing layer that delegates to sub-viewers (`ImageViewer`, `VideoViewer`, `AudioViewer`, `PdfViewer`, `UnsupportedView`, or the existing `CodeMirrorEditor`). Language packages are preloaded when `FileBrowser` lists a directory and retrieved synchronously when files open.

**Tech Stack:** React + TypeScript + CodeMirror 6 + Vitest + Testing Library, all media via native browser elements (`<img>`, `<video>`, `<audio>`, `<embed>`)

---

### Task 1: Install new CodeMirror language packages

**Files:**
- Modify: `web/package.json`

- [ ] **Step 1: Install the six new CodeMirror language packages**

```bash
cd web && npm install @codemirror/lang-shell @codemirror/lang-go @codemirror/lang-rust @codemirror/lang-cpp @codemirror/lang-sql @codemirror/lang-xml
```

- [ ] **Step 2: Verify install**

```bash
cd web && node -e "require('@codemirror/lang-shell'); require('@codemirror/lang-go'); require('@codemirror/lang-rust'); require('@codemirror/lang-cpp'); require('@codemirror/lang-sql'); require('@codemirror/lang-xml'); console.log('All packages loaded')"
```

Expected: `All packages loaded`

- [ ] **Step 3: Commit**

```bash
git add web/package.json web/package-lock.json
git commit -m "chore: add CodeMirror language packages (shell, go, rust, cpp, sql, xml)"
```

---

### Task 2: Create viewerRegistry.ts with tests

**Files:**
- Create: `web/src/lib/viewerRegistry.ts`
- Create: `web/src/lib/__tests__/viewerRegistry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/__tests__/viewerRegistry.test.ts
import { describe, it, expect } from 'vitest';
import { getViewerType, getLangKey, preloadExtensions, isViewable } from '../viewerRegistry';

describe('getViewerType', () => {
  // Images
  it.each(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])('returns "image" for .%s', (ext) => {
    expect(getViewerType(ext)).toBe('image');
  });

  // Video
  it.each(['mp4', 'webm', 'mov'])('returns "video" for .%s', (ext) => {
    expect(getViewerType(ext)).toBe('video');
  });

  // Audio
  it.each(['mp3', 'wav', 'ogg', 'flac', 'aac'])('returns "audio" for .%s', (ext) => {
    expect(getViewerType(ext)).toBe('audio');
  });

  it('returns "pdf" for .pdf', () => {
    expect(getViewerType('pdf')).toBe('pdf');
  });

  it('returns null for unknown extensions', () => {
    expect(getViewerType('exe')).toBeNull();
    expect(getViewerType('zip')).toBeNull();
    expect(getViewerType('xyz')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(getViewerType('PNG')).toBe('image');
    expect(getViewerType('Pdf')).toBe('pdf');
  });

  it('returns null for empty string', () => {
    expect(getViewerType('')).toBeNull();
  });
});

describe('getLangKey', () => {
  it('returns javascript for .js', () => {
    expect(getLangKey('js')).toBe('javascript');
  });

  it('returns typescript for .ts', () => {
    expect(getLangKey('ts')).toBe('typescript');
  });

  it('returns shell for .sh', () => {
    expect(getLangKey('sh')).toBe('shell');
  });

  it('returns go for .go', () => {
    expect(getLangKey('go')).toBe('go');
  });

  it('returns rust for .rs', () => {
    expect(getLangKey('rs')).toBe('rust');
  });

  it('returns cpp for .cpp', () => {
    expect(getLangKey('cpp')).toBe('cpp');
  });

  it('returns sql for .sql', () => {
    expect(getLangKey('sql')).toBe('sql');
  });

  it('returns xml for .xml', () => {
    expect(getLangKey('xml')).toBe('xml');
  });

  it('returns undefined for unknown extensions', () => {
    expect(getLangKey('xyz')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(getLangKey('SH')).toBe('shell');
    expect(getLangKey('GO')).toBe('go');
  });
});

describe('isViewable', () => {
  it('returns true for known image extensions', () => {
    expect(isViewable('png')).toBe(true);
  });

  it('returns false for unknown extensions', () => {
    expect(isViewable('exe')).toBe(false);
  });
});

describe('preloadExtensions', () => {
  it('extracts unique extensions from file paths', () => {
    const paths = ['a.go', 'b.go', 'c.rs', 'd.go', 'e.py'];
    const exts = preloadExtensions(paths);
    expect(exts).toEqual(['go', 'rs', 'py']);
  });

  it('excludes unknown language extensions', () => {
    const paths = ['a.xyz', 'b.go'];
    const exts = preloadExtensions(paths);
    expect(exts).toEqual(['go']);
  });

  it('handles empty array', () => {
    expect(preloadExtensions([])).toEqual([]);
  });

  it('handles paths without extensions', () => {
    const paths = ['Makefile', 'Dockerfile', 'README'];
    const exts = preloadExtensions(paths);
    expect(exts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/__tests__/viewerRegistry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write viewerRegistry.ts implementation**

```ts
// web/src/lib/viewerRegistry.ts

export type ViewerType = 'image' | 'video' | 'audio' | 'pdf';

const EXT_VIEWER_MAP: Record<string, ViewerType> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  svg: 'image', webp: 'image', bmp: 'image', ico: 'image',
  mp4: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio',
  pdf: 'pdf',
};

const EXT_LANG_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  md: 'markdown',
  html: 'html',
  css: 'css',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  go: 'go',
  rs: 'rust',
  c: 'cpp', cpp: 'cpp', h: 'cpp', hpp: 'cpp',
  sql: 'sql',
  xml: 'xml',
  toml: 'toml',
  java: 'java',
  rb: 'ruby',
};

/** Return the viewer type for a file extension, or null for unsupported. */
export function getViewerType(ext: string): ViewerType | null {
  const key = ext.toLowerCase();
  return EXT_VIEWER_MAP[key] ?? null;
}

/** Return the CodeMirror language key for a file extension, or undefined. */
export function getLangKey(ext: string): string | undefined {
  const key = ext.toLowerCase();
  return EXT_LANG_MAP[key];
}

/** Check if an extension has any viewer registered (media or code). */
export function isViewable(ext: string): boolean {
  return getViewerType(ext) !== null || getLangKey(ext) !== undefined;
}

/** Parse extension from a file path (lowercase, no leading dot). */
export function parseExt(path: string): string {
  const filename = path.split('/').pop() ?? path;
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Given a list of file paths, return unique extensions that have registered
 * CodeMirror language loaders. Used by FileBrowser to fire preload().
 */
export function preloadExtensions(paths: string[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    const ext = parseExt(path);
    if (ext && getLangKey(ext) && !seen.has(ext)) {
      seen.add(ext);
    }
  }
  return Array.from(seen);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/__tests__/viewerRegistry.test.ts`
Expected: PASS (all tests green)

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/viewerRegistry.ts web/src/lib/__tests__/viewerRegistry.test.ts
git commit -m "feat: add viewerRegistry with extension-to-viewer and extension-to-language mappings"
```

---

### Task 3: Rewrite codeMirrorLanguages.ts with lazy loading, add tests

**Files:**
- Rewrite: `web/src/lib/codeMirrorLanguages.ts`
- Create: `web/src/lib/__tests__/codeMirrorLanguages.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/__tests__/codeMirrorLanguages.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectLanguage, preload, getLanguage, getLoadedLanguages } from '../codeMirrorLanguages';

describe('detectLanguage', () => {
  it('returns "javascript" for .js', () => {
    expect(detectLanguage('app.js')).toBe('javascript');
  });

  it('returns "shell" for .sh (was missing before)', () => {
    expect(detectLanguage('deploy.sh')).toBe('shell');
  });

  it('returns "go" for .go', () => {
    expect(detectLanguage('main.go')).toBe('go');
  });

  it('returns "rust" for .rs', () => {
    expect(detectLanguage('lib.rs')).toBe('rust');
  });

  it('returns "cpp" for .cpp', () => {
    expect(detectLanguage('main.cpp')).toBe('cpp');
  });

  it('returns "sql" for .sql', () => {
    expect(detectLanguage('query.sql')).toBe('sql');
  });

  it('returns "xml" for .xml', () => {
    expect(detectLanguage('config.xml')).toBe('xml');
  });

  it('returns "text" for unknown extensions', () => {
    expect(detectLanguage('file.xyz')).toBe('text');
  });

  it('returns "text" for files without extension', () => {
    expect(detectLanguage('Makefile')).toBe('text');
  });

  it('is case-insensitive', () => {
    expect(detectLanguage('APP.JS')).toBe('javascript');
    expect(detectLanguage('DOCKERFILE')).toBe('text');
  });
});

describe('preload and getLanguage', () => {
  beforeEach(() => {
    // Reset internal state — getLoadedLanguages is diagnostic-only
  });

  it('getLanguage returns undefined before preload for lazy languages', () => {
    expect(getLanguage('go')).toBeUndefined();
  });

  it('preload loads a language package and getLanguage returns it', async () => {
    // preload is fire-and-forget; need to wait for it
    preload(['go']);
    // Wait a tick for the dynamic import to resolve
    await vi.waitFor(() => {
      expect(getLanguage('go')).toBeTruthy();
    }, { timeout: 5000 });
  });

  it('preload skips already-loaded languages (does not re-import)', async () => {
    preload(['go']);
    await vi.waitFor(() => {
      expect(getLanguage('go')).toBeTruthy();
    }, { timeout: 5000 });

    // Second call should be a no-op (no error, no re-import)
    expect(() => preload(['go'])).not.toThrow();
  });

  it('preload handles unknown extensions gracefully', () => {
    expect(() => preload(['xyz'])).not.toThrow();
    expect(getLanguage('xyz')).toBeUndefined();
  });

  it('getLanguage returns undefined for failed imports', async () => {
    // Mock a failed import — we can't easily do this in a unit test
    // without mocking the module system, so this is tested implicitly
    // by the fact that unknown language keys don't have loaders
    expect(getLanguage('unknown_lang_key')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/__tests__/codeMirrorLanguages.test.ts`
Expected: FAIL

- [ ] **Step 3: Rewrite codeMirrorLanguages.ts with lazy loading**

```ts
// web/src/lib/codeMirrorLanguages.ts
import type { Extension } from '@codemirror/state';
import type { LanguageSupport } from '@codemirror/lang-json';

// Static imports for the languages that were already bundled
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';

// Static extension map for bundled languages
const STATIC_EXTS: Record<string, Extension[]> = {
  javascript: [javascript()],
  typescript: [javascript({ typescript: true })],
  python: [python()],
  json: [json()],
  yaml: [yaml()],
  markdown: [markdown()],
  html: [html()],
  css: [css()],
};

// Lazy loader registry for dynamically-loaded languages
type LangLoader = () => Promise<LanguageSupport>;

const LAZY_LOADERS: Record<string, LangLoader> = {
  shell:    () => import('@codemirror/lang-shell').then(m => m.shell()),
  go:       () => import('@codemirror/lang-go').then(m => m.go()),
  rust:     () => import('@codemirror/lang-rust').then(m => m.rust()),
  cpp:      () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  sql:      () => import('@codemirror/lang-sql').then(m => m.sql()),
  xml:      () => import('@codemirror/lang-xml').then(m => m.xml()),
};

const loaded = new Map<string, LanguageSupport>();
const failed = new Set<string>();
const pending = new Map<string, Promise<LanguageSupport>>();

/**
 * Extension → language key mapping. Full map duplicated from viewerRegistry
 * so codeMirrorLanguages stays self-contained and doesn't couple to viewer logic.
 */
const EXT_LANG_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  md: 'markdown',
  html: 'html',
  css: 'css',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  go: 'go',
  rs: 'rust',
  c: 'cpp', cpp: 'cpp', h: 'cpp', hpp: 'cpp',
  sql: 'sql',
  xml: 'xml',
};

/**
 * Detect language from filename. Returns 'text' when no match.
 * This is the synchronous path — if the language isn't loaded yet,
 * it still returns the correct key; getLanguage handles the lookup.
 */
export function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return 'text';
  return EXT_LANG_MAP[ext] || 'text';
}

/**
 * Preload language packages for the given extensions.
 * Fire-and-forget — call this when a directory listing arrives.
 * Already-loaded and already-failed languages are skipped.
 */
export function preload(exts: string[]): void {
  for (const ext of exts) {
    const langKey = EXT_LANG_MAP[ext];
    if (!langKey) continue;
    if (loaded.has(langKey) || failed.has(langKey) || pending.has(langKey)) continue;

    const loader = LAZY_LOADERS[langKey];
    if (!loader) continue; // static language, no lazy load needed

    const promise = loader()
      .then((lang) => {
        loaded.set(langKey, lang);
        pending.delete(langKey);
        return lang;
      })
      .catch(() => {
        failed.add(langKey);
        pending.delete(langKey);
      });

    pending.set(langKey, promise);
  }
}

/**
 * Synchronously get language extensions for a language key.
 * Returns extensions array for static languages, LanguageSupport for lazy ones,
 * or undefined if the language hasn't loaded yet.
 */
export function getLanguage(langKey: string): Extension[] | undefined {
  // Check static extensions first
  if (langKey in STATIC_EXTS) {
    return STATIC_EXTS[langKey];
  }
  // Check lazy-loaded extensions
  const lang = loaded.get(langKey);
  return lang ? [lang] : undefined;
}

/** Diagnostic: list language keys that are currently loaded. */
export function getLoadedLanguages(): string[] {
  return [...Object.keys(STATIC_EXTS), ...loaded.keys()];
}
```

- [ ] **Step 4: Update CodeMirrorEditor.test.ts for new detectLanguage behavior**

The existing test in `CodeMirrorEditor.test.tsx` imports `detectLanguage` from `codeMirrorLanguages.ts`. The import path remains the same, but we need to update tests that were checking for `'text'` on extensions that now have language support (`'go'`, `'rs'`). However, the current tests only check the old set of extensions, so they should still pass. Run them to confirm.

Run: `cd web && npx vitest run src/components/__tests__/CodeMirrorEditor.test.tsx`
Expected: PASS (existing tests still pass with new codeMirrorLanguages.ts)

- [ ] **Step 5: Run all tests to verify**

Run: `cd web && npx vitest run src/lib/__tests__/`
Expected: PASS for both viewerRegistry and codeMirrorLanguages

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/codeMirrorLanguages.ts web/src/lib/__tests__/codeMirrorLanguages.test.ts
git commit -m "feat: add lazy CodeMirror language loading with preload() and getLanguage()"
```

---

### Task 4: Create ImageViewer.tsx with tests

**Files:**
- Create: `web/src/components/ImageViewer.tsx`
- Create: `web/src/components/__tests__/ImageViewer.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/components/__tests__/ImageViewer.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImageViewer } from '../ImageViewer';

// Mock URL.createObjectURL and revokeObjectURL
const mockBlobUrl = 'blob:test-url';
vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => mockBlobUrl),
  revokeObjectURL: vi.fn(),
});

function createMockBlobUrl(content: string, mimeType: string): string {
  return mockBlobUrl;
}

describe('ImageViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an image with the given blob URL', () => {
    render(<ImageViewer blobUrl={mockBlobUrl} filename="photo.png" />);
    const img = screen.getByRole('img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe(mockBlobUrl);
  });

  it('shows the filename in the toolbar', () => {
    render(<ImageViewer blobUrl={mockBlobUrl} filename="photo.png" />);
    expect(screen.getByText('photo.png')).toBeTruthy();
  });

  it('has zoom-in button that increases scale', () => {
    render(<ImageViewer blobUrl={mockBlobUrl} filename="photo.png" />);
    const zoomIn = screen.getByLabelText('Zoom in');
    fireEvent.click(zoomIn);
    const img = screen.getByRole('img');
    expect(img.style.transform).toBe('scale(1.1)');
  });

  it('has zoom-out button that decreases scale', () => {
    render(<ImageViewer blobUrl={mockBlobUrl} filename="photo.png" />);
    const zoomOut = screen.getByLabelText('Zoom out');
    fireEvent.click(zoomOut);
    const img = screen.getByRole('img');
    expect(img.style.transform).toBe('scale(0.9)');
  });

  it('toggles fit-to-screen mode', () => {
    render(<ImageViewer blobUrl={mockBlobUrl} filename="photo.png" />);
    const fitBtn = screen.getByLabelText('Fit to screen');
    fireEvent.click(fitBtn);
    const img = screen.getByRole('img');
    expect(img.className).toContain('object-contain');
  });

  it('renders the zoom percentage', () => {
    render(<ImageViewer blobUrl={mockBlobUrl} filename="photo.png" />);
    expect(screen.getByText('100%')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/__tests__/ImageViewer.test.tsx`
Expected: FAIL

- [ ] **Step 3: Write ImageViewer.tsx**

```tsx
// web/src/components/ImageViewer.tsx
import { useState, useCallback } from 'react';
import { ZoomIn, ZoomOut, Maximize, Minimize } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

export interface ImageViewerProps {
  blobUrl: string;
  filename: string;
}

export function ImageViewer({ blobUrl, filename }: ImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [fitToScreen, setFitToScreen] = useState(false);

  const zoomIn = useCallback(() => setScale((s) => Math.min(s + 0.1, 5)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(s - 0.1, 0.1)), []);
  const toggleFit = useCallback(() => setFitToScreen((f) => !f), []);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 py-1 border-b flex-shrink-0">
        <span className="text-xs font-medium text-foreground truncate max-w-[200px]">
          {filename}
        </span>
        <span className="text-xs text-muted-foreground">{Math.round(scale * 100)}%</span>
      </div>

      {/* Image */}
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-black/20">
        <img
          src={blobUrl}
          alt={filename}
          className={cn(
            'transition-transform duration-100',
            fitToScreen ? 'object-contain max-w-full max-h-full' : '',
          )}
          style={fitToScreen ? undefined : { transform: `scale(${scale})` }}
        />
      </div>

      {/* Zoom controls */}
      <div className="flex items-center justify-center gap-1 px-2 py-1 border-t flex-shrink-0">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomOut} aria-label="Zoom out">
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setScale(1)} aria-label="Reset zoom">
          <span className="text-xs font-mono">{Math.round(scale * 100)}%</span>
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomIn} aria-label="Zoom in">
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={toggleFit} aria-label="Fit to screen">
          {fitToScreen ? <Minimize className="h-3.5 w-3.5" /> : <Maximize className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/ImageViewer.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ImageViewer.tsx web/src/components/__tests__/ImageViewer.test.tsx
git commit -m "feat: add ImageViewer with zoom and fit-to-screen controls"
```

---

### Task 5: Create VideoViewer.tsx with tests

**Files:**
- Create: `web/src/components/VideoViewer.tsx`
- Create: `web/src/components/__tests__/VideoViewer.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/components/__tests__/VideoViewer.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VideoViewer } from '../VideoViewer';

vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => 'blob:video-url'),
  revokeObjectURL: vi.fn(),
});

describe('VideoViewer', () => {
  it('renders a video element with controls and the blob URL', () => {
    render(<VideoViewer blobUrl="blob:video-url" filename="demo.mp4" />);
    const video = screen.getByTestId('video-viewer');
    expect(video).toBeTruthy();
    expect(video.tagName).toBe('VIDEO');
    expect(video.getAttribute('src')).toBe('blob:video-url');
    expect(video.hasAttribute('controls')).toBe(true);
  });

  it('shows the filename', () => {
    render(<VideoViewer blobUrl="blob:video-url" filename="demo.mp4" />);
    expect(screen.getByText('demo.mp4')).toBeTruthy();
  });

  it('applies max-width styling', () => {
    render(<VideoViewer blobUrl="blob:video-url" filename="demo.mp4" />);
    const video = screen.getByTestId('video-viewer');
    expect(video.className).toContain('max-w-full');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/__tests__/VideoViewer.test.tsx`
Expected: FAIL

- [ ] **Step 3: Write VideoViewer.tsx**

```tsx
// web/src/components/VideoViewer.tsx
export interface VideoViewerProps {
  blobUrl: string;
  filename: string;
}

export function VideoViewer({ blobUrl, filename }: VideoViewerProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-2 py-1 border-b flex-shrink-0">
        <span className="text-xs font-medium text-foreground truncate max-w-[200px]">
          {filename}
        </span>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center bg-black/30">
        <video
          controls
          src={blobUrl}
          className="max-w-full max-h-full"
          data-testid="video-viewer"
        >
          Your browser does not support the video element.
        </video>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/VideoViewer.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/VideoViewer.tsx web/src/components/__tests__/VideoViewer.test.tsx
git commit -m "feat: add VideoViewer with native video controls"
```

---

### Task 6: Create AudioViewer.tsx with tests

**Files:**
- Create: `web/src/components/AudioViewer.tsx`
- Create: `web/src/components/__tests__/AudioViewer.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/components/__tests__/AudioViewer.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AudioViewer } from '../AudioViewer';

vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => 'blob:audio-url'),
  revokeObjectURL: vi.fn(),
});

describe('AudioViewer', () => {
  it('renders an audio element with controls and the blob URL', () => {
    render(<AudioViewer blobUrl="blob:audio-url" filename="song.mp3" />);
    const audio = screen.getByTestId('audio-viewer');
    expect(audio).toBeTruthy();
    expect(audio.tagName).toBe('AUDIO');
    expect(audio.getAttribute('src')).toBe('blob:audio-url');
    expect(audio.hasAttribute('controls')).toBe(true);
  });

  it('shows the filename', () => {
    render(<AudioViewer blobUrl="blob:audio-url" filename="song.mp3" />);
    expect(screen.getByText('song.mp3')).toBeTruthy();
  });

  it('shows a music icon', () => {
    render(<AudioViewer blobUrl="blob:audio-url" filename="song.mp3" />);
    expect(screen.getByTestId('audio-viewer')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/__tests__/AudioViewer.test.tsx`
Expected: FAIL

- [ ] **Step 3: Write AudioViewer.tsx**

```tsx
// web/src/components/AudioViewer.tsx
import { Music } from 'lucide-react';

export interface AudioViewerProps {
  blobUrl: string;
  filename: string;
}

export function AudioViewer({ blobUrl, filename }: AudioViewerProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-2 py-1 border-b flex-shrink-0">
        <span className="text-xs font-medium text-foreground truncate max-w-[200px]">
          {filename}
        </span>
      </div>
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4">
        <Music className="h-12 w-12 text-muted-foreground" />
        <audio
          controls
          src={blobUrl}
          className="w-full max-w-md"
          data-testid="audio-viewer"
        >
          Your browser does not support the audio element.
        </audio>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/AudioViewer.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/AudioViewer.tsx web/src/components/__tests__/AudioViewer.test.tsx
git commit -m "feat: add AudioViewer with native audio controls"
```

---

### Task 7: Create PdfViewer.tsx with tests

**Files:**
- Create: `web/src/components/PdfViewer.tsx`
- Create: `web/src/components/__tests__/PdfViewer.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/components/__tests__/PdfViewer.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PdfViewer } from '../PdfViewer';

vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => 'blob:pdf-url'),
  revokeObjectURL: vi.fn(),
});

describe('PdfViewer', () => {
  it('renders an embed element with the blob URL', () => {
    render(<PdfViewer blobUrl="blob:pdf-url" filename="doc.pdf" />);
    const embed = screen.getByTestId('pdf-viewer');
    expect(embed).toBeTruthy();
    expect(embed.tagName).toBe('EMBED');
    expect(embed.getAttribute('src')).toBe('blob:pdf-url');
    expect(embed.getAttribute('type')).toBe('application/pdf');
  });

  it('shows the filename', () => {
    render(<PdfViewer blobUrl="blob:pdf-url" filename="doc.pdf" />);
    expect(screen.getByText('doc.pdf')).toBeTruthy();
  });

  it('renders full-width and full-height embed', () => {
    render(<PdfViewer blobUrl="blob:pdf-url" filename="doc.pdf" />);
    const embed = screen.getByTestId('pdf-viewer');
    expect(embed.className).toContain('w-full');
    expect(embed.className).toContain('h-full');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/__tests__/PdfViewer.test.tsx`
Expected: FAIL

- [ ] **Step 3: Write PdfViewer.tsx**

```tsx
// web/src/components/PdfViewer.tsx
import { FileWarning } from 'lucide-react';

export interface PdfViewerProps {
  blobUrl: string;
  filename: string;
}

export function PdfViewer({ blobUrl, filename }: PdfViewerProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-2 py-1 border-b flex-shrink-0">
        <span className="text-xs font-medium text-foreground truncate max-w-[200px]">
          {filename}
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <embed
          src={blobUrl}
          type="application/pdf"
          className="w-full h-full"
          data-testid="pdf-viewer"
        />
        <noscript>
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <FileWarning className="h-8 w-8" />
            <p className="text-sm">PDF preview is not supported in this browser</p>
          </div>
        </noscript>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/PdfViewer.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/PdfViewer.tsx web/src/components/__tests__/PdfViewer.test.tsx
git commit -m "feat: add PdfViewer with native embed element"
```

---

### Task 8: Create UnsupportedView.tsx with tests

**Files:**
- Create: `web/src/components/UnsupportedView.tsx`
- Create: `web/src/components/__tests__/UnsupportedView.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/components/__tests__/UnsupportedView.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UnsupportedView } from '../UnsupportedView';

describe('UnsupportedView', () => {
  it('renders "Preview not supported" message', () => {
    render(<UnsupportedView filename="app.exe" />);
    expect(screen.getByText('Preview not supported')).toBeTruthy();
  });

  it('shows the filename', () => {
    render(<UnsupportedView filename="app.exe" />);
    expect(screen.getByText('app.exe')).toBeTruthy();
  });

  it('renders the FileWarning icon', () => {
    const { container } = render(<UnsupportedView filename="app.exe" />);
    // lucide icons render as SVG
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
  });

  it('works with different filenames', () => {
    render(<UnsupportedView filename="archive.zip" />);
    expect(screen.getByText('archive.zip')).toBeTruthy();
    expect(screen.getByText('Preview not supported')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/__tests__/UnsupportedView.test.tsx`
Expected: FAIL

- [ ] **Step 3: Write UnsupportedView.tsx**

```tsx
// web/src/components/UnsupportedView.tsx
import { FileWarning } from 'lucide-react';

export interface UnsupportedViewProps {
  filename: string;
}

export function UnsupportedView({ filename }: UnsupportedViewProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-2 py-1 border-b flex-shrink-0">
        <span className="text-xs font-medium text-foreground truncate max-w-[200px]">
          {filename}
        </span>
      </div>
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <FileWarning className="h-10 w-10" />
        <p className="text-sm">Preview not supported</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/UnsupportedView.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/UnsupportedView.tsx web/src/components/__tests__/UnsupportedView.test.tsx
git commit -m "feat: add UnsupportedView for non-viewable file formats"
```

---

### Task 9: Rewrite FileViewer.tsx as extension-routed entry point

**Files:**
- Rewrite: `web/src/components/FileViewer.tsx`
- Create: `web/src/components/__tests__/FileViewer.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/components/__tests__/FileViewer.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FileViewer } from '../FileViewer';
import type { FileOps } from '../../services/fileOps';

vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => 'blob:test-url'),
  revokeObjectURL: vi.fn(),
});

function createMockFileOps(overrides: Partial<FileOps> = {}): FileOps {
  return {
    listDir: vi.fn().mockResolvedValue({ entries: [] }),
    readFile: vi.fn().mockResolvedValue({
      path: '/test/image.png',
      content: btoa('fake-image-data'),
      mime_type: 'image/png',
    }),
    writeFile: vi.fn().mockResolvedValue({ path: '/test/file.txt', written: 10 }),
    deleteFile: vi.fn().mockResolvedValue({ path: '/test/file.txt', success: true }),
    createDir: vi.fn().mockResolvedValue({ path: '/test/dir', success: true }),
    renameFile: vi.fn().mockResolvedValue({ from: '/old', to: '/new', success: true }),
    getCwd: vi.fn().mockResolvedValue({ path: '/home' }),
    uploadFile: vi.fn().mockResolvedValue({ path: '/uploaded', written: 5 }),
    base64Decode: vi.fn((b64: string) => atob(b64)),
    base64Encode: vi.fn((s: string) => btoa(s)),
    ...overrides,
  };
}

describe('FileViewer', () => {
  const onClose = vi.fn();
  const baseProps = {
    fileOps: createMockFileOps(),
    path: '/test/image.png',
    filename: 'image.png',
    onClose,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders ImageViewer for image extensions', async () => {
    render(<FileViewer {...baseProps} path="/test/photo.png" filename="photo.png" />);
    await waitFor(() => {
      expect(screen.getByRole('img')).toBeTruthy();
    });
  });

  it('renders VideoViewer for video extensions', async () => {
    const fileOps = createMockFileOps({
      readFile: vi.fn().mockResolvedValue({
        path: '/test/demo.mp4',
        content: btoa('fake-video'),
        mime_type: 'video/mp4',
      }),
    });
    render(<FileViewer fileOps={fileOps} path="/test/demo.mp4" filename="demo.mp4" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId('video-viewer')).toBeTruthy();
    });
  });

  it('renders AudioViewer for audio extensions', async () => {
    const fileOps = createMockFileOps({
      readFile: vi.fn().mockResolvedValue({
        path: '/test/song.mp3',
        content: btoa('fake-audio'),
        mime_type: 'audio/mpeg',
      }),
    });
    render(<FileViewer fileOps={fileOps} path="/test/song.mp3" filename="song.mp3" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId('audio-viewer')).toBeTruthy();
    });
  });

  it('renders PdfViewer for .pdf', async () => {
    const fileOps = createMockFileOps({
      readFile: vi.fn().mockResolvedValue({
        path: '/test/doc.pdf',
        content: btoa('fake-pdf'),
        mime_type: 'application/pdf',
      }),
    });
    render(<FileViewer fileOps={fileOps} path="/test/doc.pdf" filename="doc.pdf" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId('pdf-viewer')).toBeTruthy();
    });
  });

  it('renders UnsupportedView immediately for unknown extensions (no fetch)', () => {
    render(<FileViewer {...baseProps} path="/test/app.exe" filename="app.exe" />);
    expect(screen.getByText('Preview not supported')).toBeTruthy();
    // Should not have called readFile
    expect(baseProps.fileOps.readFile).not.toHaveBeenCalled();
  });

  it('renders CodeMirrorEditor for text files', async () => {
    const fileOps = createMockFileOps({
      readFile: vi.fn().mockResolvedValue({
        path: '/test/readme.md',
        content: btoa('# Hello'),
        mime_type: 'text/markdown',
      }),
    });
    render(<FileViewer fileOps={fileOps} path="/test/readme.md" filename="readme.md" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId('codemirror-editor')).toBeTruthy();
    });
  });

  it('shows loading state while fetching', () => {
    const fileOps = createMockFileOps({
      readFile: vi.fn(() => new Promise(() => {})), // never resolves
    });
    render(<FileViewer fileOps={fileOps} path="/test/photo.png" filename="photo.png" onClose={onClose} />);
    // Skeleton should be visible
    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows error state on fetch failure', async () => {
    const fileOps = createMockFileOps({
      readFile: vi.fn().mockRejectedValue(new Error('Failed to load file')),
    });
    render(<FileViewer fileOps={fileOps} path="/test/photo.png" filename="photo.png" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeTruthy();
    });
  });

  it('does not show Edit/View toggle for media files', async () => {
    render(<FileViewer {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByRole('img')).toBeTruthy();
    });
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('View')).toBeNull();
  });

  it('shows Edit/View toggle for text files', async () => {
    const fileOps = createMockFileOps({
      readFile: vi.fn().mockResolvedValue({
        path: '/test/readme.md',
        content: btoa('# Hello'),
        mime_type: 'text/markdown',
      }),
    });
    render(<FileViewer fileOps={fileOps} path="/test/readme.md" filename="readme.md" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText('Edit')).toBeTruthy();
    });
  });

  it('shows close button on all viewer types', async () => {
    render(<FileViewer {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByLabelText('Close file')).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/__tests__/FileViewer.test.tsx`
Expected: FAIL

- [ ] **Step 3: Rewrite FileViewer.tsx**

```tsx
// web/src/components/FileViewer.tsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { Edit3, Save } from 'lucide-react';
import { toast } from 'sonner';
import { toastError } from '@/lib/errorHelpers';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { ImageViewer } from './ImageViewer';
import { VideoViewer } from './VideoViewer';
import { AudioViewer } from './AudioViewer';
import { PdfViewer } from './PdfViewer';
import { UnsupportedView } from './UnsupportedView';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from './ui/alert-dialog';
import { getViewerType, parseExt } from '@/lib/viewerRegistry';
import type { FileOps } from '../services/fileOps';
import type { ViewerType } from '@/lib/viewerRegistry';

export interface FileViewerProps {
  fileOps: FileOps;
  path: string;
  filename: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Decode base64 content to a Blob URL for media viewers. */
function base64ToBlobUrl(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

const VIEWER_COMPONENTS: Record<ViewerType, React.ComponentType<{ blobUrl?: string; filename: string }>> = {
  image: ImageViewer as React.ComponentType<{ blobUrl?: string; filename: string }>,
  video: VideoViewer as React.ComponentType<{ blobUrl?: string; filename: string }>,
  audio: AudioViewer as React.ComponentType<{ blobUrl?: string; filename: string }>,
  pdf: PdfViewer as React.ComponentType<{ blobUrl?: string; filename: string }>,
};

export function FileViewer({ fileOps, path, filename, onClose, onDirtyChange }: FileViewerProps) {
  const ext = parseExt(path);
  const viewerType = getViewerType(ext);
  const isText = viewerType === null;

  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [mediaBlobUrl, setMediaBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(true);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  // Revoke blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fileOps.readFile(path);

      if (viewerType) {
        // Media file: create blob URL
        const blobUrl = base64ToBlobUrl(data.content, data.mime_type);
        blobUrlRef.current = blobUrl;
        setMediaBlobUrl(blobUrl);
      } else {
        // Text file: decode to UTF-8
        const decoded = fileOps.base64Decode(data.content);
        setContent(decoded);
        setOriginalContent(decoded);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file');
    } finally {
      setLoading(false);
    }
  }, [path, fileOps, viewerType]);

  useEffect(() => {
    if (viewerType === undefined) {
      // Unsupported format — handled immediately below
      setLoading(false);
      return;
    }
    loadFile();
  }, [loadFile, viewerType]);

  const handleEditToggle = () => setIsReadOnly((prev) => !prev);

  const handleContentChange = (newContent: string) => {
    setContent(newContent);
    const dirty = newContent !== originalContent;
    setIsDirty(dirty);
    onDirtyChange?.(dirty);
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await fileOps.writeFile(path, content);
      setOriginalContent(content);
      setIsDirty(false);
      onDirtyChange?.(false);
      toast.success(`Saved ${filename}`);
    } catch (err) {
      toastError(err, 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [fileOps, path, content, filename, onDirtyChange]);

  const handleCloseClick = () => {
    if (isDirty) {
      setShowUnsavedDialog(true);
      return;
    }
    onClose();
  };

  const handleConfirmClose = () => {
    setShowUnsavedDialog(false);
    onClose();
  };

  // Unsupported format — no viewer at all
  if (viewerType === undefined) {
    return <UnsupportedView filename={filename} />;
  }

  const MediaViewerComponent = viewerType ? VIEWER_COMPONENTS[viewerType] : null;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 py-1 border-b flex-shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground truncate max-w-[200px]">{filename}</span>
          {isDirty && <span className="w-2 h-2 rounded-full bg-amber-500" title="Unsaved changes" />}
        </div>
        <div className="flex items-center gap-1">
          {isText && !isReadOnly && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleSave} disabled={!isDirty || saving}>
              <Save className="h-3 w-3 mr-1" />{saving ? 'Saving...' : 'Save'}
            </Button>
          )}
          {isText && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleEditToggle}>
              <Edit3 className="h-3 w-3 mr-1" />{isReadOnly ? 'Edit' : 'View'}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 text-xs hover:text-destructive" onClick={handleCloseClick} aria-label="Close file" title="Close file">✕</Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex flex-col p-3 gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 p-3 text-sm">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={loadFile}>Retry</Button>
          </div>
        ) : MediaViewerComponent && mediaBlobUrl ? (
          <MediaViewerComponent blobUrl={mediaBlobUrl} filename={filename} />
        ) : (
          <CodeMirrorEditor
            value={content}
            onChange={handleContentChange}
            readOnly={isReadOnly}
            filename={filename}
          />
        )}
      </div>

      {/* Unsaved changes dialog */}
      <AlertDialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Close anyway?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmClose} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Close without saving</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/FileViewer.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/FileViewer.tsx web/src/components/__tests__/FileViewer.test.tsx
git commit -m "feat: rewrite FileViewer as extension-routed viewer dispatch"
```

---

### Task 10: Update CodeMirrorEditor.tsx for lazy language loading

**Files:**
- Modify: `web/src/components/CodeMirrorEditor.tsx`

- [ ] **Step 1: Replace static getLanguageExtensions with lazy getLanguage**

```tsx
// web/src/components/CodeMirrorEditor.tsx — change the import and the getLanguageExtensions function

// Remove these static imports (they are now handled by codeMirrorLanguages.ts):
// - import { javascript } from '@codemirror/lang-javascript';
// - import { python } from '@codemirror/lang-python';
// - import { json } from '@codemirror/lang-json';
// - import { yaml } from '@codemirror/lang-yaml';
// - import { markdown } from '@codemirror/lang-markdown';
// - import { html } from '@codemirror/lang-html';
// - import { css } from '@codemirror/lang-css';

// Add this import:
// import { detectLanguage, getLanguage } from '../lib/codeMirrorLanguages';

// Replace the getLanguageExtensions function with:
function getLanguageExtensions(language: string): Extension[] {
  if (language === 'text') return [];
  const loaded = getLanguage(language);
  return loaded ?? []; // empty array = plain text, language not yet loaded
}
```
Actual edit:

In `web/src/components/CodeMirrorEditor.tsx`:

**Lines 1-13** (imports): Replace the top-section imports:
```tsx
import { useEffect, useRef, useCallback } from 'react';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { detectLanguage, getLanguage } from '../lib/codeMirrorLanguages';
```

Remove lines 5-11 (the old static language imports):
```tsx
// REMOVE these:
// import { javascript } from '@codemirror/lang-javascript';
// import { python } from '@codemirror/lang-python';
// import { json } from '@codemirror/lang-json';
// import { yaml } from '@codemirror/lang-yaml';
// import { markdown } from '@codemirror/lang-markdown';
// import { html } from '@codemirror/lang-html';
// import { css } from '@codemirror/lang-css';
```

**Lines 23-44** (getLanguageExtensions): Replace the entire function:
```tsx
function getLanguageExtensions(language: string): Extension[] {
  if (language === 'text') return [];
  const loaded = getLanguage(language);
  return loaded ?? [];
}
```

- [ ] **Step 2: Run CodeMirrorEditor tests to verify existing behavior**

Run: `cd web && npx vitest run src/components/__tests__/CodeMirrorEditor.test.tsx`
Expected: PASS — existing tests should still pass since static languages (javascript, typescript, python, etc.) are still handled in codeMirrorLanguages.ts

- [ ] **Step 3: Commit**

```bash
git add web/src/components/CodeMirrorEditor.tsx
git commit -m "refactor: switch CodeMirrorEditor to lazy language loading via getLanguage()"
```

---

### Task 11: Update FileBrowser.tsx — 10MB gate + preload

**Files:**
- Modify: `web/src/components/FileBrowser.tsx`
- Modify: `web/src/hooks/useFileBrowserDialogs.ts`

- [ ] **Step 1: Update FileBrowser.tsx**

Three changes to `web/src/components/FileBrowser.tsx`:

**Change 1 — Add import for preload (insert after existing import at line 40):**
```tsx
import { preloadExtensions } from '@/lib/viewerRegistry';
import { preload } from '@/lib/codeMirrorLanguages';
```

**Change 2 — Replace MAX_SIZE_WARNING with MAX_SIZE_GATE and update handleEntryClick:**
```tsx
// Line 57: Replace
// const MAX_SIZE_WARNING = 1 * 1024 * 1024; // 1 MB
// With:
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB — hard gate, matches backend limit
```

```tsx
// Lines 101-111: Replace handleEntryClick
const handleEntryClick = (entry: FileEntry) => {
  if (entry.is_dir) {
    setCurrentPath(entry.path);
  } else {
    if (entry.size > MAX_FILE_SIZE) {
      toast.error(`File too large for preview (>${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB)`);
      return;
    }
    onFileClick(entry);
  }
};
```

**Change 3 — Add preload call in loadDir (after setEntries):**
```tsx
// In loadDir, after setEntries(result.entries):
// Line 79 currently: setEntries(result.entries);
// Add after it:
const exts = preloadExtensions(result.entries.map((e) => e.path));
if (exts.length > 0) {
  preload(exts);
}
```

**Change 4 — Remove large file dialog:**
In `FileBrowser.tsx`:
- Remove the `largeFileTarget` dialog from `FileBrowserDialogs` component (lines 409-422)
- Remove `largeFileTarget`, `onLargeFileTargetChange`, and `onFileClick` from `FileBrowserDialogsProps` interface
- Remove the `largeFileTarget` prop usage in the parent's `FileBrowserDialogs` call (line 363-369)

Simplified `FileBrowserDialogs`:
```tsx
interface FileBrowserDialogsProps {
  deleteTarget: FileEntry | null;
  onDeleteTargetChange: (target: FileEntry | null) => void;
  onDeleteConfirm: () => void;
}

function FileBrowserDialogs({
  deleteTarget,
  onDeleteTargetChange,
  onDeleteConfirm,
}: FileBrowserDialogsProps) {
  return (
    <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) { onDeleteTargetChange(null); } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {deleteTarget?.is_dir ? 'directory' : 'file'}?</AlertDialogTitle>
          <AlertDialogDescription>
            Delete {deleteTarget?.is_dir ? `directory "${deleteTarget?.name}"` : `"${deleteTarget?.name}"`}? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onDeleteConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

And the parent's call becomes:
```tsx
<FileBrowserDialogs
  deleteTarget={dialogs.deleteTarget}
  onDeleteTargetChange={dialogs.setDeleteTarget}
  onDeleteConfirm={handleDeleteConfirm}
/>
```

- [ ] **Step 2: Update useFileBrowserDialogs.ts to remove largeFileTarget**

```ts
// web/src/hooks/useFileBrowserDialogs.ts
import { useState } from 'react';
import type { FileEntry } from '../services/fileOps';

/**
 * Dialog target state for FileBrowser.
 * Manages the delete confirmation dialog.
 */
export function useFileBrowserDialogs() {
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

  return {
    deleteTarget,
    setDeleteTarget,
  };
}
```

Remove `largeFileTarget`, `setLargeFileTarget` from the return object.

- [ ] **Step 3: Run existing tests and verify build**

Run: `cd web && npx tsc --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```bash
git add web/src/components/FileBrowser.tsx web/src/hooks/useFileBrowserDialogs.ts
git commit -m "feat: add 10MB size gate and language preload to FileBrowser"
```

---

### Task 12: Run full test suite + lint + typecheck

**Files:** (none created/modified — verification only)

- [ ] **Step 1: Run all Vitest tests**

Run: `cd web && npx vitest run`
Expected: PASS (all tests green, coverage ≥ 80%)

- [ ] **Step 2: Run ESLint**

Run: `cd web && npm run lint`
Expected: PASS (0 errors, 0 warnings)

- [ ] **Step 3: Run TypeScript check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 4: If any test/type/lint failures, fix them inline. Then re-run.**

- [ ] **Step 5: Commit if any fixes were made**

```bash
git add -A
git commit -m "fix: resolve test/lint/type issues from file viewer enhancement"
```

---

### Task 13: Final commit

- [ ] **Step 1: Verify git status**

Run: `git status`
Expected: working tree clean

- [ ] **Step 2: Final commit (if anything outstanding)**

```bash
git commit -m "feat: complete file viewer enhancement — multi-format media support, lazy syntax highlighting, 10MB size limit"
```
