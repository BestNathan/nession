# Executable Design Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canonical JSON tokens, generated Web CSS, and error-level ESLint so product TSX cannot use Tailwind palette or literal colors — without restyling the current Zinc UI.

**Architecture:** `design/tokens/*.json` is the source. `design/scripts/generate-tokens.mjs` writes `design/generated/{web.css,lint-metadata.json,app.ts}`. `web/src/index.css` imports generated CSS. Local `web/eslint-plugin-nession` reads lint-metadata. Product files replace primitive classes with semantic/domain utilities. No Style Dictionary. No `crates/`. No indigo visual restyle.

**Tech Stack:** Node (`node:test` for codegen), ESLint 9 RuleTester, Tailwind v4 `@theme`, Vitest for existing UI tests, Playwright MCP for PR screenshots.

**Spec:** `docs/superpowers/specs/2026-08-27-executable-design-tokens-design.md`  
**Issue:** #467  
**Worktree:** `.claude/worktrees/feat-design-tokens` on `feat/design-tokens` (based on `origin/staging`)

---

## File Structure

| File | Responsibility |
|------|----------------|
| `design/tokens/primitive.json` | Raw oklch/px values only |
| `design/tokens/semantic.json` | Light/dark refs → primitive; shadcn names + success/warning/info/overlay/inverse |
| `design/tokens/domain.json` | agent/session/attachment/terminal/workspace/file/editor refs |
| `design/tokens/experience/web.json` | Web density sizes |
| `design/tokens/experience/app.json` | App density sizes (not in web.css) |
| `design/scripts/generate-tokens.mjs` | Resolve refs, emit generated files; `--check` |
| `design/scripts/generate-tokens.test.mjs` | `node:test` for codegen |
| `design/generated/web.css` | Committed `:root` / `.dark` / `@theme` color bridges |
| `design/generated/lint-metadata.json` | Primitive ids + suggestions |
| `design/generated/app.ts` | Typed App experience stub |
| `web/eslint-plugin-nession/` | `no-primitive-tokens`, `no-cross-experience-token` |
| `web/src/index.css` | Import generated CSS; drop hand-written color `:root` |
| `justfile` | `tokens-gen`, `tokens-check`; `web-lint` runs `tokens-check` first |

**Do not modify:** `crates/**`, `k8s/overlays/**`, `ThemeManager.ts` (eslint ignore only), protocol.

Commit from worktree root. Co-author: `Co-Authored-By: Claude <noreply@anthropic.com>`

**Enable `nession/no-primitive-tokens` in `eslint.config.js` only in Task 8**, after product files and tests are migrated. Earlier tasks must keep `just web-lint` green.

---

### Task 1: Codegen + token JSON

**Files:**
- Create: `design/scripts/generate-tokens.mjs`
- Create: `design/scripts/generate-tokens.test.mjs`
- Create: `design/tokens/primitive.json`, `semantic.json`, `domain.json`, `experience/web.json`, `experience/app.json`
- Create: `design/generated/` (written by generator; do not hand-author CSS)

- [ ] **Step 1: Write failing codegen tests**

`design/scripts/generate-tokens.test.mjs` using `node:test` + `node:assert/strict`. Tests import functions that **do not exist yet**.

Cover at least:

1. `resolveRef` follows `{ "ref": "primitive.color.green.500" }` to `{ "value": "oklch(0.63 0.17 145)" }`.
2. Missing ref throws (non-zero path for CLI later).
3. `generateWebCss` emits `:root { --background: … }` and `.dark { --background: … }` from semantic themes; emits `--color-success: var(--success);` inside `@theme inline`.
4. Domain token `--agent-online` appears; `--agent-connecting` appears even when it aliases muted-foreground.
5. `generateWebCss` does **not** emit App `touch-target-min` / `control-app-*`.
6. `generateLintMetadata` marks `green-500` as `layer: "primitive"`, `allowedInComponent: false`, with suggestions including `success` and `agent-online`.
7. `generateAppTs` exports numeric `touchTarget.min === 44`.
8. Domain JSON has no raw `oklch(` / `#` / `rgb(` values (walk production `domain.json` after it exists — put this assertion in a second test file **or** the same file reading `../tokens/domain.json` once JSON is added in Step 3; for Step 1 only test the fixture object in-memory).

Fixture tokens inline in the test (do not require production JSON for unit tests 1–7).

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRef,
  generateWebCss,
  generateLintMetadata,
  generateAppTs,
} from './generate-tokens.mjs';

const fixture = {
  primitive: {
    color: {
      zinc: { 50: { value: 'oklch(0.985 0 0)' }, 950: { value: 'oklch(0.145 0 0)' } },
      green: { 500: { value: 'oklch(0.63 0.17 145)' } },
    },
  },
  semantic: {
    themes: {
      light: { background: { ref: 'primitive.color.zinc.50' }, success: { ref: 'primitive.color.green.500' } },
      dark: { background: { ref: 'primitive.color.zinc.950' }, success: { ref: 'primitive.color.green.500' } },
    },
  },
  domain: {
    agent: {
      online: { ref: 'primitive.color.green.500' },
      connecting: { ref: 'semantic.themes.light.background' },
    },
  },
  experience: {
    web: { control: { sm: { value: '28px' } } },
    app: { touchTarget: { min: { value: 44 } }, control: { md: { value: '44px' } } },
  },
};
```

- [ ] **Step 2: Run tests — they must fail**

```bash
node --test design/scripts/generate-tokens.test.mjs
```

Expected: FAIL (module not found or named exports missing).

- [ ] **Step 3: Implement generator + production JSON**

`generate-tokens.mjs` must:

- `import.meta.url` relative reads of `../tokens/*.json`
- Deep `ref` resolution (`primitive.color.green.500`, `semantic.themes.light.background`)
- CLI: default write `design/generated/web.css`, `lint-metadata.json`, `app.ts`; `--check` writes to os temp and `diff`s (exit 1 on mismatch)
- Header comment on generated files: `/* generated — do not edit */`
- `web.css` structure:

```css
/* generated — do not edit */
:root { /* semantic light + domain (resolved) + experience.web sizes as --control-sm etc */ }
.dark { /* semantic dark + domain dark if domain has themes; else same domain refs re-resolved in dark by pointing domain at semantic tokens that change */ }
@theme inline {
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-info: var(--info);
  --color-overlay: var(--overlay);
  --color-inverse: var(--inverse);
  --color-warning-foreground: var(--warning-foreground);
  --color-success-foreground: var(--success-foreground);
  --color-info-foreground: var(--info-foreground);
  --color-agent-online: var(--agent-online);
  /* all domain kebab-case --color-* */
}
```

**Dark domain:** domain.json refs semantic names (`semantic.danger` not a theme path) so `.dark` reassignment of `--destructive` automatically updates `--agent-error` if agent.error refs semantic.danger. Prefer domain refs like `{ "ref": "semantic.success" }` where semantic is the **unthemed name** whose `:root`/`.dark` values already switch. Implement `semantic.success` as a token whose CSS variable is `--success` set per theme.

**Production primitive.json** must include enough stops to reproduce current `web/src/index.css` `:root` and `.dark` oklch for: background, foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, radius, charts, sidebar*, plus:

- green used by current `--agent-online` (light `oklch(0.63 0.17 145)`, dark `oklch(0.72 0.17 145)`)
- Tailwind-like green/amber/red/blue 500 for semantic success/warning/info (LoginPage check should stay looking like `green-500`)
- black `oklch(0 0 0)` for overlay/inverse
- white `oklch(1 0 0)` / near-white for *-foreground

**semantic.json themes.light / themes.dark:** map every current shadcn variable name (`background`, `foreground`, `destructive`, `muted-foreground`, …) plus `success`, `warning`, `info`, `overlay`, `inverse`, `success-foreground`, `warning-foreground`, `info-foreground`. `danger` aliases `destructive` (same CSS var `--destructive` is enough; also emit `--danger: var(--destructive)` if needed). Overlay = black. Inverse = black.

**domain.json:** every name in `docs/design/design-system/tokens.md`. `agent.connecting` / `reconnecting` / `offline` → muted-foreground. `agent.error` → destructive. `session.unknown` → muted-foreground. `attachment.attaching` / `detached` → muted-foreground. `file.modified` → warning. `file.created` → success. `file.deleted` → destructive. `file.selected` → accent. `terminal.*` may alias background/foreground/ring. `workspace.*` alias background/card/muted. `editor.*` alias background/muted/accent.

**experience/web.json:** control 28/32/36px, row 28/36/40px, icon 14/16px, panel.padding 12px.

**experience/app.json:** control 36/44/52, row 40/48/56, icon 18/20, panel.padding 16, touchTarget.min 44.

**lint-metadata.json** keys: Tailwind palette ids `green-500`, `green-400`, `emerald-500`, `amber-500`, `amber-400`, `amber-600`, `yellow-600`, `red-500`, `red-400`, `red-600`, `blue-500`, `blue-400`, `blue-300`, `blue-800`, `blue-700`, `blue-100`, `blue-200`, `gray-400`, `gray-500`, `black`, `white`, and `layer: primitive`. Suggestions per spec mapping table.

No `agent.thinking` keys anywhere.

- [ ] **Step 4: Run tests — pass; generate production artifacts**

```bash
node --test design/scripts/generate-tokens.test.mjs
node design/scripts/generate-tokens.mjs
```

Expected: tests pass; `design/generated/web.css` contains `--agent-online` and `--background`.

- [ ] **Step 5: Commit**

```bash
git add design/
git commit -m "$(cat <<'EOF'
feat: add token JSON and CSS codegen

Canonical primitive/semantic/domain/experience JSON drives generated
Web CSS and lint metadata for #467.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire generated CSS + just recipes

**Files:**
- Modify: `web/src/index.css`
- Modify: `justfile`

- [ ] **Step 1: Add a failing check that generated CSS is what index will import**

No new test file required if `node design/scripts/generate-tokens.mjs --check` exists. Verify `--check` fails when you temporarily edit `design/generated/web.css` then restore. Then implement `--check` if Task 1 left it incomplete.

- [ ] **Step 2: Import generated CSS; delete hand-written color variables**

At the **top** of `web/src/index.css` (before `@import "tailwindcss"`):

```css
@import "../../design/generated/web.css";
```

If Vite cannot resolve `../../design/`, fix with a Vite alias or `@import` URL that **does not duplicate values**. Do not copy oklch back into `index.css`.

Remove from `index.css`:

- All `--agent-*`, `--session-*`, `--attachment-*` in `:root` and `.dark`
- All `--color-agent-*` etc. in `@theme inline`
- The entire `:root` and `.dark` **color** custom properties that now live in generated CSS (`--background` through sidebar and domain). Keep non-color layout rules (`html, body`, markdown frontmatter, scrollbar-none, `@custom-variant dark`, remaining `@theme` radius/font/shadcn `--color-background: var(--background)` bridges).

If generated `web.css` already emits `@theme inline { --color-background: var(--background); … }` for shadcn names, delete duplicate `--color-*` from `index.css` `@theme`. Prefer **one** `@theme` block in generated file for colors; `index.css` keeps radius/font `@theme` only.

- [ ] **Step 3: just recipes**

```just
tokens-gen:
    node design/scripts/generate-tokens.mjs

tokens-check:
    node design/scripts/generate-tokens.mjs --check
```

Do **not** add `tokens-check` to `web-lint` until Task 8.

- [ ] **Step 4: Smoke**

```bash
just tokens-check
cd web && npx tsc --noEmit
```

Expected: tokens-check pass. App still typechecks. (Visual: `bg-background` still works because `--background` exists.)

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: import generated tokens into the Web theme

index.css consumes design/generated/web.css so Session-first domain
colors and shadcn variables share one source.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: ESLint `nession/no-primitive-tokens`

**Files:**
- Create: `web/eslint-plugin-nession/index.js` (or `.mjs` matching `"type": "module"`)
- Create: `web/eslint-plugin-nession/rules/no-primitive-tokens.js`
- Create: `web/eslint-plugin-nession/__tests__/no-primitive-tokens.test.js`

- [ ] **Step 1: Failing RuleTester tests** (plugin not in `eslint.config.js` yet)

Use ESLint 9 `RuleTester`. Load `design/generated/lint-metadata.json` the same way the rule will.

Invalid (must error):

- `className="text-green-500"`
- `className="bg-green-500/30"`
- `className="bg-[#fff]"`
- `className="bg-black/40"`
- `style={{ color: '#fff' }}`
- `className="prose-a:text-blue-300"`
- `className="var(--n-green-500)"` or `className="bg-[var(--primitive-green-500)]"` if codegen emits that form — if codegen never emits `--n-*`, still flag `var(--primitive-` and Tailwind palettes.

Valid:

- `className="text-agent-online"`
- `className="bg-background"`
- `className="border-success/30"`
- `className="bg-overlay"`
- `className="text-muted-foreground"`

Error message must mention a suggestion from metadata (e.g. `success` or `agent-online` for `green-500`).

- [ ] **Step 2: Run tests — fail**

```bash
cd web && node --test eslint-plugin-nession/__tests__/no-primitive-tokens.test.js
```

Expected: FAIL (rule missing).

- [ ] **Step 3: Implement rule**

Scan `Literal` strings and `TemplateElement` values for class-like tokens. Scan `JSXAttribute` `style` objects for `color` / `background` / `backgroundColor` / `borderColor` with hex/rgb/oklch.

Palette regex: prefixes `text|bg|border|ring|from|to|via|fill|stroke|outline|decoration|accent|caret|divide|shadow` + optional `prose-a:` / `hover:` / `dark:` variants + palette name + optional `-NUMBER` + optional `/opacity`.

Palettes: `red|green|blue|yellow|amber|orange|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|zinc|neutral|slate|gray|stone|lime|black|white`.

Do not flag `text-foreground`, `border-border`, `bg-primary`.

Ignore files are **not** this task (Task 8).

- [ ] **Step 4: Tests pass**

```bash
cd web && node --test eslint-plugin-nession/__tests__/no-primitive-tokens.test.js
```

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: add nession/no-primitive-tokens ESLint rule

Flag Tailwind palettes, arbitrary colors, and inline hex/rgb/oklch
using generated lint metadata for suggestions.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: ESLint `nession/no-cross-experience-token`

**Files:**
- Create: `web/eslint-plugin-nession/rules/no-cross-experience-token.js`
- Create: `web/eslint-plugin-nession/__tests__/no-cross-experience-token.test.js`
- Modify: `web/eslint-plugin-nession/index.js` to export the rule

- [ ] **Step 1: Failing tests**

Invalid in a Web file: class `touch-target-min`, `control-app-md` (match names emitted conceptually for App — document the exact strings in lint-metadata as `experienceAppClasses: ["touch-target-min", "control-app-sm", "control-app-md", "control-app-lg"]`).

Valid: `control-sm` only if Web actually emits it; if Web experience is CSS variables not utilities, flag only the App list. **Do not invent Web `control-sm` utilities in this task.**

- [ ] **Step 2–4:** TDD implement, tests pass, commit:

```
feat: add nession/no-cross-experience-token

Web TSX cannot use App experience class names.
```

---

### Task 5: Migrate Dashboard / env / login / address / banners

**Files (class replacements only, no restyle):**

| File | Replace |
|------|---------|
| `web/src/components/ui/ConnectionStatusBadge.tsx` | `bg-red-500` → `bg-destructive`; `bg-amber-500` → `bg-warning`; `bg-green-500` → `bg-success`; `bg-blue-500` → `bg-info` |
| `web/src/components/LoginPage.tsx` | `text-green-500` → `text-success` |
| `web/src/components/AddressSelector.tsx` | green/red/amber wifi → `text-success` / `text-destructive` / `text-warning` |
| `web/src/components/env/AttachDialog.tsx` | same as AddressSelector |
| `web/src/components/env/EnvInlineEditor.tsx` | `text-amber-*` → `text-warning` |
| `web/src/components/env/EnvEditorDialog.tsx` | same |
| `web/src/components/env/EnvPanel.tsx` | `text-emerald-500` → `text-success` |
| `web/src/components/TerminalBanner.tsx` | amber/white → `bg-warning` + `text-warning-foreground` |
| `web/src/terminal/components/TerminalBanner.tsx` | yellow/red/white → `bg-warning` / `bg-destructive` + matching `*-foreground` |
| `web/src/components/AgentCard.tsx` | `border-green-500/30` → `border-agent-online/30` |
| `web/src/components/SessionList.tsx` | `active` → `bg-session-active`; `detached` → `bg-session-active/60`; else `bg-session-unknown` |
| `web/src/components/SessionPanel.tsx` | same |
| `web/src/components/SessionDropdown.tsx` | same |
| `web/src/components/AgentDetailPanel.tsx` | heartbeat age pills → `success` / `warning` / `danger` (destructive); **session row dots** in that panel: `active` → `bg-session-active`; `detached` → `bg-session-active/60`; else `bg-session-unknown`. Pulse/online dots that mean Agent → `bg-agent-online`. Gray “no data” → `text-muted-foreground` / `bg-muted`. |

- [ ] **Step 1:** Grep the listed files for remaining `text-green-500` etc. After edits, grep must be empty for palettes in those files.

- [ ] **Step 2:** Run existing tests that still pass:

```bash
cd web && npx vitest run src/components/__tests__/integration/AgentCard.test.tsx src/components/__tests__/integration/AddressSelector.test.tsx
```

AddressSelector still looks for `.text-amber-500` — **leave that assertion failing until Task 7** OR update it in this task if you touch AddressSelector. Prefer **update the assertion here** to `.text-warning` so the suite stays green:

`web/src/components/__tests__/integration/AddressSelector.test.tsx`: `.text-amber-500` → `.text-warning`.

- [ ] **Step 3: Commit**

```
fix: replace Dashboard status colors with semantic and domain tokens
```

---

### Task 6: Migrate files, markdown, overlays, session-first fallbacks

**Files:**

| File | Replace |
|------|---------|
| `web/src/components/env/EnvDiff.tsx` | added → `bg-file-created/10 text-file-created`; removed → `bg-file-deleted/10 text-file-deleted` |
| `web/src/components/FileViewer.tsx` | dirty `bg-amber-500` → `bg-file-modified`; amber banners → warning tokens; blue banners/buttons → `info` |
| `web/src/components/FileTabs.tsx` | `bg-amber-500` → `bg-file-modified` |
| `web/src/components/FileBrowser.tsx` | `text-blue-400` → `text-info` |
| `web/src/components/MarkdownPreview.tsx` | blue banner/links → `info` (`prose-a:text-info`) |
| `web/src/extensions/claude-code/components/ConfigViewer.tsx` | `text-amber-400` → `text-warning` |
| `web/src/components/ui/sheet.tsx` | `bg-black/10` → `bg-overlay/10` |
| `web/src/components/ui/dialog.tsx` | `bg-black/10` → `bg-overlay/10` |
| `web/src/components/ui/alert-dialog.tsx` | `bg-black/80` → `bg-overlay/80` |
| `web/src/components/SidePanel.tsx` | `bg-black/40` → `bg-overlay/40` |
| `web/src/components/ImageViewer.tsx` | `bg-black/20` → `bg-inverse/20` |
| `web/src/components/VideoViewer.tsx` | `bg-black/30` → `bg-inverse/30` |
| `web/src/components/SessionPreviewDialog.tsx` | `bg-black/50` → `bg-inverse/50` |
| `web/src/session-first/patterns/ConnectionStatus.tsx` | `session.unknown` / `attachment.attaching|detached` → `text-session-unknown` / `text-attachment-attaching` / `text-attachment-detached` instead of `text-muted-foreground` |

- [ ] **Step 1–2:** Replace; grep `web/src` for palette classes (except ThemeManager). Run:

```bash
cd web && npx vitest run src/session-first/__tests__/integration src/components/__tests__/integration/FileBrowser.test.tsx
```

- [ ] **Step 3: Commit**

```
fix: replace file, overlay, and remaining palette colors with tokens
```

---

### Task 7: Remaining tests + `cn()` fixture

**Files:**
- `web/src/lib/__tests__/unit/utils.test.ts` — `bg-blue-500` → `btn-primary` (non-palette)
- Any other `__tests__` still asserting old palette classes (grep `amber-500|green-500|blue-500|red-500|bg-black`)

- [ ] **Step 1:** Grep `web/` for palette strings. Only allowed leftovers: `ThemeManager.ts`, `ThemeManager.test.ts`, comments, this plan/spec.

- [ ] **Step 2:**

```bash
cd web && npx vitest run src/lib/__tests__/unit/utils.test.ts
```

- [ ] **Step 3: Commit**

```
test: stop asserting Tailwind palette classes
```

---

### Task 8: Enable lint in CI

**Files:**
- Modify: `web/eslint.config.js` — plugin `nession`, rules error, ignores ThemeManager
- Modify: `justfile` `web-lint` to run `just tokens-check` first
- Modify: `web/package.json` if needed so eslint can load `./eslint-plugin-nession`

- [ ] **Step 1:** Add plugin. Ignores:

```js
{
  files: ['src/terminal/ThemeManager.ts', 'src/terminal/__tests__/unit/ThemeManager.test.ts'],
  rules: {
    'nession/no-primitive-tokens': 'off',
  },
}
```

Also ignore `eslint-plugin-nession/**` if RuleTester fixtures would self-flag.

- [ ] **Step 2:**

```bash
just tokens-check
cd web && npx eslint . --report-unused-disable-directives --max-warnings 0
cd web && npx tsc --noEmit
```

Expected: 0 errors. If any remain, **fix them in this task** (do not `eslint-disable`).

- [ ] **Step 3: Commit**

```
feat: enforce token lint and generated-CSS drift in web-lint
```

---

### Task 9: Playwright verification

Local demo (`HOME=/tmp/nession-demo`, server config must bind `127.0.0.1:19090` — not the 8080 default). Web `npm run dev` on `:13000`.

- [ ] Flag **off**: Dashboard AgentCard online border still visible; screenshot `.playwright-mcp/screenshots/tokens-dashboard-agent.png`
- [ ] Flag **on** (`?session_first=1`): list + Agent channel colors; screenshot `.playwright-mcp/screenshots/tokens-session-first.png`
- [ ] Console: no new errors from missing CSS variables

Do not commit screenshots. Note paths for the PR comment.

- [ ] **Commit** only if you needed a code fix found in Playwright:

```
fix: … 
```

If no code change, do not empty-commit.

---

## Self-review (plan vs spec)

| Spec item | Task |
|-----------|------|
| JSON source + codegen | 1 |
| Generated web.css imported | 2 |
| No restyle / capture current oklch | 1 primitives |
| no-primitive-tokens error | 3 + 8 |
| no-cross-experience-token | 4 + 8 |
| ThemeManager exempt | 8 |
| Mapping table | 5, 6 |
| Tests as product | 7 |
| tokens-check in web-lint | 8 |
| Playwright | 9 |
| No crates / no #472 cutover | all |
| `Closes #467` not in feat PR | (PR later) |
