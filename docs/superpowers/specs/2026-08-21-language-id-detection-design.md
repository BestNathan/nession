# LanguageId Detection + CodeMirror Lang Pack Loading

**Date:** 2026-08-21
**Issue:** #353
**Status:** Draft

## Problem

File browser language detection is scattered across two modules with identification coupled to rendering:

- `viewerRegistry.ts`: `EXT_LANG_MAP` (ext → UIW key), `BASENAME_VIEWABLE` (only 7 files)
- `codeMirrorLangs.ts`: `resolveLangKey()` returns UIW key directly, `BASENAME_LANG_KEYS` (7 basenames), no pattern/shebang/fallback

Issues:
1. **Identification coupled to rendering** — `resolveLangKey()` returns `@uiw/codemirror-extensions-langs` keys (including `__dockerfile__` special value), not reusable for LSP, formatters, icons, etc.
2. **Incomplete rules** — no filename patterns (`.env.*`, `*Dockerfile*`), no shebang detection, no unified fallback; `README` / `.bashrc` / `go.mod` detected inconsistently
3. **Viewable vs highlightable conflated** — `isViewablePath()` uses `getLangKey(ext)` to decide, but `Cargo.toml` has extension, `README` has none and is not in basename table → asymmetric behavior
4. **False degradation/upgrade** — LanguageIds without CodeMirror grammar (e.g., `go.mod`) should not force-alias to a similar grammar; should degrade to `plaintext` instead
5. **#310 intersection** — markdown content heuristic should be an optional terminal step in the LanguageId pipeline, not a separate bypass

## Solution

Introduce VS Code-style **`LanguageId`** as the single output of file language identification, decoupled from CodeMirror grammar loading.

### Architecture

```
filename + content?  →  detectLanguage()  →  LanguageId
                                              ↓
                              languageIdToCodeMirrorKey()
                                              ↓
                              loadLangExtension / prefetch
```

### Detection Priority (fixed)

```
explicit language (prop/override)
  ↓
exact basename match
  ↓
filename pattern rules
  ↓
extension match
  ↓
shebang (requires content)
  ↓
content heuristic (optional, markdown etc.)
  ↓
plaintext
```

### Key Design Decisions

1. **`LanguageId` is VS Code semantics, not CodeMirror key**
   - `shellscript` not `sh`; mapping layer handles aliases
   - Enables reuse for LSP, icons, formatters without touching detection logic

2. **`LanguageId → CodeMirror LanguageSupport` is a separate mapping layer**
   - Only load grammar when available; otherwise `plaintext`
   - No hard-aliasing: `go.mod` → `go` LanguageId → `plaintext` if no go.mod grammar

3. **Basename/pattern before extension**
   - `.gitignore` → `plaintext` (basename), not `ignore` extension
   - `Dockerfile` → `dockerfile` (basename), not null
   - Dotfile pseudo-extensions: `.bashrc` → `shellscript` (basename), not `bashrc` extension

4. **Shebang as fallback for extensionless files**
   - `#!/usr/bin/env bash` → `shellscript`
   - Only checked when basename/pattern/extension all miss

5. **Content heuristic is last and optional**
   - Only when basename/pattern/extension/shebang all miss
   - #310 markdown detection integrates here, does not override higher-priority signals

6. **Viewable vs highlightable separated**
   - `isViewablePath()` based on LanguageId + media viewer map
   - A file can be viewable (text) but not highlightable (no grammar) → plaintext

### Scope

**In scope:**
- New `LanguageId` union type + `detectLanguage()` function
- Rule tables: `BASENAME_RULES`, `EXTENSION_RULES`, `PATTERN_RULES`, `detectShebang()`
- New `languageIdToCodeMirrorKey()` / `loadLangExtensionForLanguageId()` mapping layer
- Refactor `viewerRegistry.ts`: `isViewablePath()` based on LanguageId + media map
- Refactor `codeMirrorLangs.ts`: prefetch based on LanguageId → available CodeMirror key
- Update/add unit tests (≥30 cases covering each priority layer)
- Align with #310: content heuristic as optional terminal step in `detectLanguage`

**Out of scope:**
- FileBrowser UX (fuzzy finder, #207)
- Large file chunking (#323)
- Tree-sitter / LSP integration (LanguageId designed for reuse, but not implemented here)
- Manual language override UI (pipeline reserves `explicit language` entry, UI later)

### Success Criteria

1. `detectLanguage('Dockerfile')` → `dockerfile`; `detectLanguage('deploy', '#!/usr/bin/env bash\n...')` → `shellscript`; `detectLanguage('README')` → `markdown`; `detectLanguage('unknown.xyz')` → `plaintext`
2. `detectLanguage('.env.local')` → `plaintext` (pattern); `.env` → `plaintext` (breaking but intentional)
3. CodeMirror layer: `dockerfile` → legacy mode; `typescript` → UIW `ts`; no-grammar LanguageId → plaintext, no error
4. FileBrowser prefetch: only needed lang packs loaded, not full set
5. `isViewablePath('README')` === true; `isViewablePath('random.bin')` === false
6. All existing tests updated and passing; new `detectLanguage` tests ≥ 30 cases
7. #310 path: `detectLanguage('Dockerfile', dockerfileContent)` → `dockerfile`, not `markdown`

### Edge Cases

| Case | Expected LanguageId | CodeMirror |
|------|---------------------|------------|
| `tsconfig.json` | `jsonc` | json (or jsonc if UIW supports) |
| `.gitignore` | `plaintext` | none |
| `go.mod` | `go` (semantic) | plaintext if no go.mod grammar |
| `Gemfile` | `ruby` | rb |
| `Makefile` | `makefile` | sh/makefile alias per mapping |
| `.bashrc` | `shellscript` | sh |
| Extensionless + shebang python | `python` | py |
| `foo.d.ts` | `typescript` | ts (pattern or extension) |
| Binary / unknown | `plaintext` | none |
| Explicit `language` prop override | user value | mapped |

**Dotfile pseudo-extension:** `.gitignore` currently parsed as `gitignore` extension; new detector uses basename/pattern first.

**Dual-purpose files:** `.svg` is both image viewer and xml/lang — media viewer wins.

**Content heuristic boundary:** Only runs when basename/pattern/extension/shebang all miss; composable with #310 markdown AST improvements but cannot override higher-priority signals.

### Constraints

- Keep `@uiw/codemirror-extensions-langs` dynamic import strategy (directory scan triggers prefetch, not eager load all)
- No `eslint-disable` / no lowering coverage thresholds
- LanguageId naming aligned with VS Code (`shellscript` not `sh`; mapping layer handles aliases)
- LanguageIds without CodeMirror grammar **must** return plaintext, never hard-alias to wrong grammar

### Testing Strategy

- Unit tests for each priority layer (≥30 cases)
- Shebang detection for extensionless scripts
- No-grammar LanguageId → plaintext degradation
- Integration with existing `codeMirrorLangs` / `viewerRegistry` tests
- Coverage threshold: web branches 65% (per `scripts/check-coverage.sh`)

## Implementation Notes

- New module: `web/src/lib/languageId.ts` (or refactor existing modules)
- `LanguageId` type: union of ~60 VS Code-style identifiers
- `detectLanguage(filename: string, content?: string): LanguageId`
- `languageIdToCodeMirrorKey(id: LanguageId): string | null`
- `loadLangExtensionForLanguageId(id: LanguageId): Promise<Extension | null>`
- Refactor `scanLangKeysFromPaths` → `scanLanguageIdsFromPaths`
- Update `registerSeenLangKeys` → `registerSeenLanguageIds`

## Related

- #310 — markdown content heuristic mis-detection (integrates into unified pipeline terminal)
- #323 — large file chunking (independent)
- #195 (closed) — Markdown preview initial requirement
