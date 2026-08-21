# LanguageId Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce VS Code-style `LanguageId` detection decoupled from CodeMirror grammar loading, with fixed priority pipeline (basename → pattern → extension → shebang → content heuristic → plaintext).

**Architecture:** New `languageId.ts` module defines `LanguageId` union type (~60 identifiers), `detectLanguage(filename, content?)` with fixed priority, and rule tables. New `languageIdToCodeMirror.ts` maps LanguageId to CodeMirror `LanguageSupport` (plaintext fallback when no grammar). Refactor `viewerRegistry.ts` and `codeMirrorLangs.ts` to consume LanguageId instead of UIW keys directly.

**Tech Stack:** TypeScript, Vitest, `@uiw/codemirror-extensions-langs`, `@codemirror/legacy-modes`

**Spec:** `docs/superpowers/specs/2026-08-21-language-id-detection-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `web/src/lib/languageId.ts` | **New.** `LanguageId` type, `detectLanguage()`, rule tables (`BASENAME_RULES`, `EXTENSION_RULES`, `PATTERN_RULES`), `detectShebang()` |
| `web/src/lib/languageIdToCodeMirror.ts` | **New.** `languageIdToCodeMirrorKey()`, `loadLangExtensionForLanguageId()` |
| `web/src/lib/viewerRegistry.ts` | **Modify.** Refactor `isViewablePath()` to use LanguageId + media map; deprecate `getLangKey()` |
| `web/src/lib/codeMirrorLangs.ts` | **Modify.** Refactor `scanLangKeysFromPaths()` → `scanLanguageIdsFromPaths()`; `loadLangExtensionForFile()` delegates to LanguageId pipeline |
| `web/src/lib/__tests__/unit/languageId.test.ts` | **New.** ≥30 test cases covering each priority layer |
| `web/src/lib/__tests__/unit/languageIdToCodeMirror.test.ts` | **New.** Mapping layer tests |
| `web/src/lib/__tests__/unit/viewerRegistry.test.ts` | **Modify.** Update tests for LanguageId-based logic |
| `web/src/lib/__tests__/unit/codeMirrorLangs.test.ts` | **Modify.** Update tests for LanguageId-based logic |

---

## Task 1: Define LanguageId Type and Rule Tables

**Files:**
- Create: `web/src/lib/languageId.ts`
- Test: `web/src/lib/__tests__/unit/languageId.test.ts`

- [ ] **Step 1: Write failing test for LanguageId type and basic detectLanguage()**

```typescript
// web/src/lib/__tests__/unit/languageId.test.ts
import { describe, expect, it } from 'vitest';
import { detectLanguage, type LanguageId } from '../languageId';

describe('detectLanguage', () => {
  describe('basename priority', () => {
    it('detects Dockerfile', () => {
      expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    });

    it('detects Makefile', () => {
      expect(detectLanguage('Makefile')).toBe('makefile');
    });

    it('detects README as markdown', () => {
      expect(detectLanguage('README')).toBe('markdown');
    });

    it('detects .gitignore as plaintext', () => {
      expect(detectLanguage('.gitignore')).toBe('plaintext');
    });

    it('detects .bashrc as shellscript', () => {
      expect(detectLanguage('.bashrc')).toBe('shellscript');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test -- languageId.test.ts
```

Expected: FAIL — `languageId` module not found

- [ ] **Step 3: Define LanguageId type and BASENAME_RULES**

```typescript
// web/src/lib/languageId.ts

/** VS Code-style language identifiers (subset for v1). */
export type LanguageId =
  | 'plaintext'
  | 'markdown'
  | 'json'
  | 'jsonc'
  | 'yaml'
  | 'toml'
  | 'xml'
  | 'html'
  | 'css'
  | 'scss'
  | 'less'
  | 'javascript'
  | 'typescript'
  | 'jsx'
  | 'tsx'
  | 'vue'
  | 'svelte'
  | 'rust'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'scala'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'objective-c'
  | 'swift'
  | 'python'
  | 'ruby'
  | 'php'
  | 'lua'
  | 'perl'
  | 'r'
  | 'dart'
  | 'elixir'
  | 'erlang'
  | 'haskell'
  | 'zig'
  | 'nim'
  | 'shellscript'
  | 'powershell'
  | 'sql'
  | 'graphql'
  | 'dockerfile'
  | 'makefile'
  | 'cmake'
  | 'terraform'
  | 'protobuf'
  | 'nginx'
  | 'ini'
  | 'properties'
  | 'diff'
  | 'git-commit'
  | 'git-rebase';

/** Exact basename → LanguageId. */
const BASENAME_RULES: Record<string, LanguageId> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  GNUmakefile: 'makefile',
  README: 'markdown',
  README.md: 'markdown',
  README.txt: 'markdown',
  Gemfile: 'ruby',
  Rakefile: 'ruby',
  Jenkinsfile: 'groovy',
  'CMakeLists.txt': 'cmake',
  '.gitignore': 'plaintext',
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
  '.profile': 'shellscript',
};

/** Parse basename from path. */
export function parseBasename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Parse extension from path (lowercase, no leading dot). */
export function parseExt(path: string): string {
  const filename = parseBasename(path);
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) {
    return '';
  }
  return filename.slice(dot + 1).toLowerCase();
}

/** Detect language from filename and optional content. */
export function detectLanguage(filename: string, content?: string): LanguageId {
  const basename = parseBasename(filename);

  // Priority 1: explicit override (not implemented in this function; caller handles)

  // Priority 2: exact basename match
  if (basename in BASENAME_RULES) {
    return BASENAME_RULES[basename];
  }

  // Priority 3: filename pattern rules (TODO in next task)

  // Priority 4: extension match (TODO in next task)

  // Priority 5: shebang detection (TODO in next task)

  // Priority 6: content heuristic (TODO in next task)

  // Priority 7: plaintext fallback
  return 'plaintext';
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web && npm test -- languageId.test.ts
```

Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/languageId.ts web/src/lib/__tests__/unit/languageId.test.ts
git commit -m "feat: add LanguageId type and basename detection

- Define LanguageId union type (VS Code semantics)
- Implement detectLanguage() with basename priority
- Add BASENAME_RULES for common files (Dockerfile, Makefile, README, etc.)
- Parse basename and extension helpers

Ref: #353

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Add Extension Rules

**Files:**
- Modify: `web/src/lib/languageId.ts`
- Modify: `web/src/lib/__tests__/unit/languageId.test.ts`

- [ ] **Step 1: Write failing tests for extension detection**

```typescript
// Add to web/src/lib/__tests__/unit/languageId.test.ts
describe('extension priority', () => {
  it('detects .ts as typescript', () => {
    expect(detectLanguage('foo.ts')).toBe('typescript');
  });

  it('detects .rs as rust', () => {
    expect(detectLanguage('main.rs')).toBe('rust');
  });

  it('detects .py as python', () => {
    expect(detectLanguage('script.py')).toBe('python');
  });

  it('detects .json as json', () => {
    expect(detectLanguage('package.json')).toBe('json');
  });

  it('detects .md as markdown', () => {
    expect(detectLanguage('README.md')).toBe('markdown');
  });

  it('detects .env as properties (breaking change → plaintext)', () => {
    expect(detectLanguage('.env')).toBe('plaintext');
  });

  it('detects unknown extension as plaintext', () => {
    expect(detectLanguage('file.xyz')).toBe('plaintext');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test -- languageId.test.ts
```

Expected: FAIL — 7 tests fail (extension detection not implemented)

- [ ] **Step 3: Add EXTENSION_RULES to languageId.ts**

```typescript
// Add to web/src/lib/languageId.ts after BASENAME_RULES

/** Extension → LanguageId (lowercase, no leading dot). */
const EXTENSION_RULES: Record<string, LanguageId> = {
  // JavaScript / TypeScript
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',

  // Python
  py: 'python',
  pyw: 'python',
  pyx: 'python',

  // Data formats
  json: 'json',
  jsonld: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',

  // Markup
  md: 'markdown',
  markdown: 'markdown',
  mkd: 'markdown',
  html: 'html',
  htm: 'html',

  // Styles
  css: 'css',
  scss: 'scss',
  less: 'less',
  sass: 'scss',
  styl: 'css',

  // Shell
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ksh: 'shellscript',

  // Compiled languages
  go: 'go',
  rs: 'rust',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  swift: 'swift',
  cs: 'csharp',
  fs: 'csharp',
  m: 'objective-c',
  mm: 'objective-c',

  // Scripting
  rb: 'ruby',
  php: 'php',
  phtml: 'php',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  jl: 'julia',
  dart: 'dart',

  // Functional
  hs: 'haskell',
  exs: 'elixir',
  ex: 'elixir',
  erl: 'erlang',

  // Config
  ini: 'ini',
  properties: 'properties',
  cfg: 'ini',
  conf: 'nginx',

  // Web frameworks
  vue: 'vue',
  svelte: 'svelte',

  // Database
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',

  // Infrastructure
  tf: 'terraform',
  hcl: 'terraform',
  proto: 'protobuf',
  nix: 'nix',
  dockerfile: 'dockerfile',
  cmake: 'cmake',

  // PowerShell
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',

  // Misc
  vim: 'vim',
  prisma: 'prisma',
  solidity: 'solidity',
  csv: 'plaintext',
  log: 'plaintext',
  lock: 'plaintext',
  mod: 'plaintext',
  sum: 'plaintext',

  // .d.ts files (TypeScript declaration)
  'd.ts': 'typescript',
};

// Update detectLanguage() to check extension after basename
export function detectLanguage(filename: string, content?: string): LanguageId {
  const basename = parseBasename(filename);

  // Priority 2: exact basename match
  if (basename in BASENAME_RULES) {
    return BASENAME_RULES[basename];
  }

  // Priority 3: filename pattern rules (TODO)

  // Priority 4: extension match
  const ext = parseExt(filename);
  if (ext && ext in EXTENSION_RULES) {
    return EXTENSION_RULES[ext];
  }

  // Handle special case: .d.ts (double extension)
  if (filename.endsWith('.d.ts')) {
    return 'typescript';
  }

  // Priority 5: shebang (TODO)
  // Priority 6: content heuristic (TODO)

  // Priority 7: plaintext fallback
  return 'plaintext';
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web && npm test -- languageId.test.ts
```

Expected: PASS — 12 tests (5 basename + 7 extension)

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/languageId.ts web/src/lib/__tests__/unit/languageId.test.ts
git commit -m "feat: add extension-based language detection

- Add EXTENSION_RULES mapping (~80 extensions to LanguageId)
- detectLanguage() checks extension after basename
- Handle .d.ts double extension as typescript
- .env maps to plaintext (breaking change from properties)

Ref: #353

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Add Pattern Rules and Shebang Detection

**Files:**
- Modify: `web/src/lib/languageId.ts`
- Modify: `web/src/lib/__tests__/unit/languageId.test.ts`

- [ ] **Step 1: Write failing tests for pattern and shebang**

```typescript
// Add to web/src/lib/__tests__/unit/languageId.test.ts
describe('pattern priority', () => {
  it('detects .env.local as plaintext', () => {
    expect(detectLanguage('.env.local')).toBe('plaintext');
  });

  it('detects .env.production as plaintext', () => {
    expect(detectLanguage('.env.production')).toBe('plaintext');
  });

  it('detects foo.d.ts as typescript', () => {
    expect(detectLanguage('foo.d.ts')).toBe('typescript');
  });
});

describe('shebang priority', () => {
  it('detects shellscript from shebang', () => {
    const content = '#!/usr/bin/env bash\necho hello';
    expect(detectLanguage('deploy', content)).toBe('shellscript');
  });

  it('detects python from shebang', () => {
    const content = '#!/usr/bin/python3\nprint("hi")';
    expect(detectLanguage('script', content)).toBe('python');
  });

  it('detects node from shebang', () => {
    const content = '#!/usr/bin/env node\nconsole.log("hi")';
    expect(detectLanguage('app', content)).toBe('javascript');
  });

  it('ignores shebang when extension exists', () => {
    const content = '#!/usr/bin/env bash\necho hello';
    expect(detectLanguage('script.py', content)).toBe('python');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test -- languageId.test.ts
```

Expected: FAIL — 7 tests fail

- [ ] **Step 3: Add PATTERN_RULES and detectShebang()**

```typescript
// Add to web/src/lib/languageId.ts

/** Filename pattern → LanguageId (regex match). */
const PATTERN_RULES: Array<{ pattern: RegExp; language: LanguageId }> = [
  { pattern: /^\.env(\..*)?$/, language: 'plaintext' },
  { pattern: /\.d\.ts$/, language: 'typescript' },
  { pattern: /Dockerfile/i, language: 'dockerfile' },
];

/** Detect language from shebang line. */
export function detectShebang(content: string): LanguageId | null {
  const firstLine = content.split('\n')[0];
  if (!firstLine.startsWith('#!')) {
    return null;
  }

  const shebang = firstLine.toLowerCase();

  // Shell
  if (shebang.includes('bash') || shebang.includes('sh') || shebang.includes('zsh')) {
    return 'shellscript';
  }

  // Python
  if (shebang.includes('python')) {
    return 'python';
  }

  // Node.js
  if (shebang.includes('node')) {
    return 'javascript';
  }

  // Ruby
  if (shebang.includes('ruby')) {
    return 'ruby';
  }

  // Perl
  if (shebang.includes('perl')) {
    return 'perl';
  }

  return null;
}

// Update detectLanguage()
export function detectLanguage(filename: string, content?: string): LanguageId {
  const basename = parseBasename(filename);

  // Priority 2: exact basename match
  if (basename in BASENAME_RULES) {
    return BASENAME_RULES[basename];
  }

  // Priority 3: filename pattern rules
  for (const { pattern, language } of PATTERN_RULES) {
    if (pattern.test(basename)) {
      return language;
    }
  }

  // Priority 4: extension match
  const ext = parseExt(filename);
  if (ext && ext in EXTENSION_RULES) {
    return EXTENSION_RULES[ext];
  }

  // Handle special case: .d.ts (double extension)
  if (filename.endsWith('.d.ts')) {
    return 'typescript';
  }

  // Priority 5: shebang detection
  if (content) {
    const fromShebang = detectShebang(content);
    if (fromShebang) {
      return fromShebang;
    }
  }

  // Priority 6: content heuristic (TODO)

  // Priority 7: plaintext fallback
  return 'plaintext';
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web && npm test -- languageId.test.ts
```

Expected: PASS — 19 tests

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/languageId.ts web/src/lib/__tests__/unit/languageId.test.ts
git commit -m "feat: add pattern rules and shebang detection

- Add PATTERN_RULES for .env.*, .d.ts, Dockerfile patterns
- Implement detectShebang() for extensionless scripts
- detectLanguage() checks patterns after basename, shebang after extension
- Shebang supports bash/sh/python/node/ruby/perl

Ref: #353

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Add Content Heuristic (Markdown Detection)

**Files:**
- Modify: `web/src/lib/languageId.ts`
- Modify: `web/src/lib/__tests__/unit/languageId.test.ts`

- [ ] **Step 1: Write failing tests for content heuristic**

```typescript
// Add to web/src/lib/__tests__/unit/languageId.test.ts
describe('content heuristic priority', () => {
  it('detects markdown from content when basename/extension miss', () => {
    const content = '# Title\n\nSome paragraph with **bold**.';
    expect(detectLanguage('NOTES', content)).toBe('markdown');
  });

  it('does not override basename with content heuristic', () => {
    const content = '# Title\n\nSome paragraph.';
    expect(detectLanguage('Dockerfile', content)).toBe('dockerfile');
  });

  it('does not override extension with content heuristic', () => {
    const content = '# Title\n\nSome paragraph.';
    expect(detectLanguage('README.txt', content)).toBe('markdown');
  });

  it('falls back to plaintext when no heuristic matches', () => {
    const content = 'random text without structure';
    expect(detectLanguage('unknown', content)).toBe('plaintext');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test -- languageId.test.ts
```

Expected: FAIL — 4 tests fail

- [ ] **Step 3: Add content heuristic for markdown**

```typescript
// Add to web/src/lib/languageId.ts

/** Detect markdown from content (simple heuristic). */
function detectMarkdownFromContent(content: string): boolean {
  // Check for common markdown patterns
  const lines = content.split('\n');
  for (const line of lines.slice(0, 10)) {
    // Headings
    if (/^#{1,6}\s+/.test(line)) return true;
    // Bold/italic
    if (/\*\*[^*]+\*\*/.test(line)) return true;
    // Links
    if (/\[[^\]]+\]\([^)]+\)/.test(line)) return true;
    // Lists
    if (/^[-*+]\s+/.test(line)) return true;
    if (/^\d+\.\s+/.test(line)) return true;
  }
  return false;
}

// Update detectLanguage()
export function detectLanguage(filename: string, content?: string): LanguageId {
  const basename = parseBasename(filename);

  // Priority 2: exact basename match
  if (basename in BASENAME_RULES) {
    return BASENAME_RULES[basename];
  }

  // Priority 3: filename pattern rules
  for (const { pattern, language } of PATTERN_RULES) {
    if (pattern.test(basename)) {
      return language;
    }
  }

  // Priority 4: extension match
  const ext = parseExt(filename);
  if (ext && ext in EXTENSION_RULES) {
    return EXTENSION_RULES[ext];
  }

  // Handle special case: .d.ts (double extension)
  if (filename.endsWith('.d.ts')) {
    return 'typescript';
  }

  // Priority 5: shebang detection
  if (content) {
    const fromShebang = detectShebang(content);
    if (fromShebang) {
      return fromShebang;
    }
  }

  // Priority 6: content heuristic
  if (content && detectMarkdownFromContent(content)) {
    return 'markdown';
  }

  // Priority 7: plaintext fallback
  return 'plaintext';
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web && npm test -- languageId.test.ts
```

Expected: PASS — 23 tests

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/languageId.ts web/src/lib/__tests__/unit/languageId.test.ts
git commit -m "feat: add content heuristic for markdown detection

- Implement detectMarkdownFromContent() with simple pattern matching
- Content heuristic runs last (after basename/pattern/extension/shebang)
- Does not override higher-priority signals
- Aligns with #310: markdown detection as terminal optional step

Ref: #353

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Implement LanguageId → CodeMirror Mapping Layer

**Files:**
- Create: `web/src/lib/languageIdToCodeMirror.ts`
- Test: `web/src/lib/__tests__/unit/languageIdToCodeMirror.test.ts`

- [ ] **Step 1: Write failing tests for mapping layer**

```typescript
// web/src/lib/__tests__/unit/languageIdToCodeMirror.test.ts
import { describe, expect, it } from 'vitest';
import { languageIdToCodeMirrorKey } from '../languageIdToCodeMirror';

describe('languageIdToCodeMirrorKey', () => {
  it('maps typescript to ts', () => {
    expect(languageIdToCodeMirrorKey('typescript')).toBe('ts');
  });

  it('maps shellscript to sh', () => {
    expect(languageIdToCodeMirrorKey('shellscript')).toBe('sh');
  });

  it('maps dockerfile to __dockerfile__', () => {
    expect(languageIdToCodeMirrorKey('dockerfile')).toBe('__dockerfile__');
  });

  it('maps ruby to rb', () => {
    expect(languageIdToCodeMirrorKey('ruby')).toBe('rb');
  });

  it('maps python to py', () => {
    expect(languageIdToCodeMirrorKey('python')).toBe('py');
  });

  it('returns null for plaintext', () => {
    expect(languageIdToCodeMirrorKey('plaintext')).toBeNull();
  });

  it('returns null for go (no grammar in UIW)', () => {
    expect(languageIdToCodeMirrorKey('go')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test -- languageIdToCodeMirror.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement mapping layer**

```typescript
// web/src/lib/languageIdToCodeMirror.ts
import type { LanguageId } from './languageId';

/** Map LanguageId to @uiw/codemirror-extensions-langs key. */
const LANGUAGE_ID_TO_CODEMIRROR: Partial<Record<LanguageId, string>> = {
  javascript: 'js',
  typescript: 'ts',
  jsx: 'jsx',
  tsx: 'tsx',
  python: 'py',
  ruby: 'rb',
  shellscript: 'sh',
  rust: 'rs',
  markdown: 'md',
  dockerfile: '__dockerfile__',
  json: 'json',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  graphql: 'graphql',
  java: 'java',
  kotlin: 'kt',
  scala: 'scala',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  'objective-c': 'mm',
  php: 'php',
  lua: 'lua',
  perl: 'pl',
  r: 'r',
  dart: 'dart',
  elixir: 'exs',
  erlang: 'erl',
  haskell: 'hs',
  vue: 'vue',
  svelte: 'svelte',
  ini: 'ini',
  properties: 'properties',
  terraform: 'tf',
  protobuf: 'proto',
  cmake: 'cmake',
  powershell: 'ps1',
  vim: 'vim',
};

/** Map LanguageId to CodeMirror key, or null if no grammar available. */
export function languageIdToCodeMirrorKey(languageId: LanguageId): string | null {
  return LANGUAGE_ID_TO_CODEMIRROR[languageId] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web && npm test -- languageIdToCodeMirror.test.ts
```

Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/languageIdToCodeMirror.ts web/src/lib/__tests__/unit/languageIdToCodeMirror.test.ts
git commit -m "feat: add LanguageId to CodeMirror mapping layer

- languageIdToCodeMirrorKey() maps ~45 LanguageIds to UIW keys
- Returns null for plaintext and LanguageIds without grammar (e.g., go)
- Decouples identification from rendering

Ref: #353

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Refactor viewerRegistry.ts to Use LanguageId

**Files:**
- Modify: `web/src/lib/viewerRegistry.ts`
- Modify: `web/src/lib/__tests__/unit/viewerRegistry.test.ts`

- [ ] **Step 1: Write failing tests for LanguageId-based isViewablePath()**

```typescript
// Add to web/src/lib/__tests__/unit/viewerRegistry.test.ts
import { isViewablePath } from '../viewerRegistry';

describe('isViewablePath with LanguageId', () => {
  it('README is viewable (markdown)', () => {
    expect(isViewablePath('README')).toBe(true);
  });

  it('random.bin is not viewable', () => {
    expect(isViewablePath('random.bin')).toBe(false);
  });

  it('.gitignore is viewable (plaintext)', () => {
    expect(isViewablePath('.gitignore')).toBe(true);
  });

  it('image.png is viewable (media)', () => {
    expect(isViewablePath('image.png')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify current behavior**

```bash
cd web && npm test -- viewerRegistry.test.ts
```

Expected: Some tests may fail (README not viewable in current implementation)

- [ ] **Step 3: Refactor isViewablePath() to use LanguageId**

```typescript
// Modify web/src/lib/viewerRegistry.ts
import { detectLanguage, type LanguageId } from './languageId';

/** Media extensions that are viewable. */
const MEDIA_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico',
  'mp4', 'webm', 'mov',
  'mp3', 'wav', 'ogg', 'flac', 'aac',
  'pdf',
]);

/** Check if a path is openable in FileViewer (media or text/code). */
export function isViewablePath(path: string): boolean {
  const ext = parseExt(path);

  // Media files
  if (MEDIA_EXTENSIONS.has(ext)) {
    return true;
  }

  // Text/code files: detect language
  const languageId = detectLanguage(path);

  // All LanguageIds except plaintext are viewable (they have some meaning)
  // But we also allow plaintext for text files (e.g., .gitignore, .env)
  // Heuristic: if languageId is not plaintext, or if the file has a text-like extension
  if (languageId !== 'plaintext') {
    return true;
  }

  // Plaintext is viewable if it has a known text extension or is a known text basename
  const textExtensions = new Set(['txt', 'text', 'log', 'env', 'ini', 'cfg', 'conf']);
  if (textExtensions.has(ext)) {
    return true;
  }

  // Known text basenames
  const textBasenames = new Set(['.gitignore', '.env', '.env.local', '.env.production']);
  const basename = parseBasename(path);
  if (textBasenames.has(basename) || basename.startsWith('.env.')) {
    return true;
  }

  return false;
}

// Deprecate getLangKey() but keep for backward compatibility
/** @deprecated Use detectLanguage() + languageIdToCodeMirrorKey() instead. */
export function getLangKey(ext: string): string | undefined {
  // ... existing implementation ...
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web && npm test -- viewerRegistry.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/viewerRegistry.ts web/src/lib/__tests__/unit/viewerRegistry.test.ts
git commit -m "refactor: use LanguageId in isViewablePath()

- Separate media viewer from text/code viewer
- Use detectLanguage() to determine viewability
- README now viewable (markdown), .gitignore viewable (plaintext)
- Deprecate getLangKey() in favor of LanguageId pipeline

Ref: #353

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Refactor codeMirrorLangs.ts to Use LanguageId

**Files:**
- Modify: `web/src/lib/codeMirrorLangs.ts`
- Modify: `web/src/lib/__tests__/unit/codeMirrorLangs.test.ts`

- [ ] **Step 1: Write failing tests for LanguageId-based scanning**

```typescript
// Add to web/src/lib/__tests__/unit/codeMirrorLangs.test.ts
import { scanLanguageIdsFromPaths } from '../codeMirrorLangs';

describe('scanLanguageIdsFromPaths', () => {
  it('scans LanguageIds from directory listing', () => {
    const paths = ['foo.ts', 'bar.rs', 'Dockerfile', 'README'];
    const ids = scanLanguageIdsFromPaths(paths);
    expect(ids).toContain('typescript');
    expect(ids).toContain('rust');
    expect(ids).toContain('dockerfile');
    expect(ids).toContain('markdown');
  });

  it('excludes plaintext from prefetch', () => {
    const paths = ['.gitignore', '.env'];
    const ids = scanLanguageIdsFromPaths(paths);
    expect(ids).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test -- codeMirrorLangs.test.ts
```

Expected: FAIL — `scanLanguageIdsFromPaths` not found

- [ ] **Step 3: Refactor codeMirrorLangs.ts**

```typescript
// Modify web/src/lib/codeMirrorLangs.ts
import { detectLanguage, type LanguageId } from './languageId';
import { languageIdToCodeMirrorKey } from './languageIdToCodeMirror';

/** Collect unique LanguageIds from a directory listing. */
export function scanLanguageIdsFromPaths(paths: string[]): LanguageId[] {
  const seen = new Set<LanguageId>();
  for (const path of paths) {
    const id = detectLanguage(path);
    if (id !== 'plaintext') {
      seen.add(id);
    }
  }
  return [...seen];
}

/** Load syntax highlighting extension for a LanguageId. */
export async function loadLangExtensionForLanguageId(
  languageId: LanguageId,
): Promise<Extension | null> {
  const key = languageIdToCodeMirrorKey(languageId);
  if (!key) {
    return null;
  }
  return extensionForLangKey(key);
}

/** Load syntax highlighting extension for a file path. */
export async function loadLangExtensionForFile(
  path: string,
  language?: string,
): Promise<Extension | null> {
  // Explicit override
  if (language) {
    const languageId = language as LanguageId;
    return loadLangExtensionForLanguageId(languageId);
  }

  const languageId = detectLanguage(path);
  return loadLangExtensionForLanguageId(languageId);
}

// Keep registerSeenLangKeys for backward compatibility
/** @deprecated Use registerSeenLanguageIds() instead. */
export function registerSeenLangKeys(keys: Iterable<string>): void {
  // ... existing implementation ...
}

/** Register LanguageIds seen in FileBrowser; prefetches langs module. */
export function registerSeenLanguageIds(ids: Iterable<LanguageId>): void {
  for (const id of ids) {
    const key = languageIdToCodeMirrorKey(id);
    if (key) {
      sessionSeenLangKeys.add(key);
    }
  }
  if (sessionSeenLangKeys.size > 0) {
    void ensureLangsModule();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web && npm test -- codeMirrorLangs.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/codeMirrorLangs.ts web/src/lib/__tests__/unit/codeMirrorLangs.test.ts
git commit -m "refactor: use LanguageId in codeMirrorLangs.ts

- Add scanLanguageIdsFromPaths() replacing scanLangKeysFromPaths()
- loadLangExtensionForFile() delegates to LanguageId pipeline
- Add registerSeenLanguageIds() for prefetch
- Keep backward-compatible registerSeenLangKeys() with deprecation

Ref: #353

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Update Existing Tests and Ensure Coverage

**Files:**
- Modify: `web/src/lib/__tests__/unit/viewerRegistry.test.ts`
- Modify: `web/src/lib/__tests__/unit/codeMirrorLangs.test.ts`

- [ ] **Step 1: Run all tests to find failures**

```bash
cd web && npm test
```

Expected: Some existing tests may fail due to refactoring

- [ ] **Step 2: Fix failing tests**

Update existing tests to use LanguageId-based logic. For example:
- Tests expecting `resolveLangKey()` to return UIW key directly → update to use `detectLanguage()` + `languageIdToCodeMirrorKey()`
- Tests for `isViewablePath()` → update for new LanguageId-based logic

- [ ] **Step 3: Run coverage check**

```bash
cd web && npm run coverage
```

Expected: branches ≥ 65%, lines/functions/statements ≥ 80%

- [ ] **Step 4: Add more test cases if needed**

Ensure ≥30 test cases for `detectLanguage()` covering:
- 5+ basename cases
- 7+ extension cases
- 3+ pattern cases
- 4+ shebang cases
- 4+ content heuristic cases
- Edge cases (dotfiles, double extensions, unknown files)

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/__tests__/unit/
git commit -m "test: update existing tests for LanguageId refactor

- Fix viewerRegistry tests for LanguageId-based isViewablePath()
- Fix codeMirrorLangs tests for LanguageId-based scanning
- Ensure ≥30 test cases for detectLanguage()
- Coverage: branches ≥ 65%, lines/functions/statements ≥ 80%

Ref: #353

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Run Quality Gates and Verify Build

**Files:**
- None (verification only)

- [ ] **Step 1: Run TypeScript check**

```bash
cd web && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 2: Run ESLint**

```bash
cd web && npm run lint
```

Expected: 0 warnings

- [ ] **Step 3: Run build**

```bash
cd web && npm run build
```

Expected: success

- [ ] **Step 4: Run all tests**

```bash
cd web && npm test
```

Expected: all tests pass

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "chore: fix lint/build issues from LanguageId refactor

Ref: #353

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Playwright Functional Verification

**Files:**
- None (verification only)

- [ ] **Step 1: Start local stack**

```bash
# Terminal 1
HOME=/tmp/nession-demo cargo run -p nession-server

# Terminal 2
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml

# Terminal 3
cd web && npm run dev
```

- [ ] **Step 2: Open browser and verify file detection**

Use Playwright MCP to:
- Navigate to http://localhost:13000
- Log in
- Navigate to FileBrowser
- Open various files and verify correct language detection:
  - `README` → markdown preview
  - `Dockerfile` → dockerfile syntax highlighting
  - `.bashrc` → shellscript highlighting
  - `foo.ts` → typescript highlighting
  - `.gitignore` → plaintext (no highlighting)

- [ ] **Step 3: Take screenshots**

```bash
# Use mcp__playwright__browser_take_screenshot for key states
# Save to .playwright-mcp/screenshots/
```

- [ ] **Step 4: Verify console and network**

```bash
# Check browser console for errors
mcp__playwright__browser_console_messages level: error

# Check network for correct lang pack loading
mcp__playwright__browser_network_requests filter: "/langs/"
```

Expected: no errors, only needed lang packs loaded

- [ ] **Step 5: Commit screenshots (if any changes)**

```bash
git add .playwright-mcp/screenshots/
git commit -m "docs: add Playwright verification screenshots

Ref: #353

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Summary

**Total tasks:** 10
**Estimated time:** 4-6 hours
**Key deliverables:**
- `LanguageId` type with ~60 identifiers
- `detectLanguage()` with fixed priority pipeline
- `languageIdToCodeMirrorKey()` mapping layer
- Refactored `viewerRegistry.ts` and `codeMirrorLangs.ts`
- ≥30 unit tests
- Playwright verification screenshots

**Next step:** After completing all tasks, create PR to staging with test report and screenshots.
