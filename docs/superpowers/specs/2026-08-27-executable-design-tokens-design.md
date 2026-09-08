# Executable Design Tokens

**Date:** 2026-08-27  
**Status:** Approved  
**Requirements:** GitHub Issue [#467](https://github.com/BestNathan/nession/issues/467)  
**Parent:** [#468](https://github.com/BestNathan/nession/issues/468)  
**Architecture vocabulary:** [`docs/design/design-system/tokens.md`](../../design/design-system/tokens.md)  
**Branch base:** `origin/staging` (`feat/design-tokens`) so Session-first domain CSS from [#471](https://github.com/BestNathan/nession/issues/471) is in tree

---

## Overview

Turn UI Architecture v2 token vocabulary into a **platform-neutral source**, **generated Web CSS**, and **CI-enforced ESLint** so product TSX cannot use Tailwind palette / literal colors.

This PR also **migrates every current product primitive color class to semantic or domain tokens** (`just web-lint` stays `--max-warnings 0`, rule severity **error**). It does **not** restyle the product (no indigo accent, no new surface ladder). Current Zinc/oklch values are captured as primitives and aliased through semantic/domain names.

---

## Key Decisions

### 1. Small custom codegen, not Style Dictionary

**Decision:** Node script `design/scripts/generate-tokens.mjs` reads JSON and writes generated artifacts. No Style Dictionary / Theo / token-transformer dependency.

**Rationale:** Issue asks for static artifacts and no heavy design-system runtime. The mapping onto Tailwind 4 `@theme` is Nession-specific.

### 2. Tokenize the current look; do not apply the indigo visual direction

**Decision:** Primitive values are the oklch already in `web/src/index.css` `:root` / `.dark`, plus the Session-first `--agent-*` / `--session-*` / `--attachment-*` stops, plus the extra semantic hues those product classes were faking with `green-500` / `amber-500` / `red-500` / `blue-500` (same visual, new names).

**Rationale:** #467 Phase 4 is “no primitive in components,” not “ship a new theme.” Visual restyle is a later change to primitive/semantic JSON only.

### 3. Lint is error everywhere in `web/src/**/*.{ts,tsx}`

**Decision:** `nession/no-primitive-tokens` is `error`. No warn-only period. No `eslint-disable` (repo forbids it). File-level **plugin ignores** only for documented technical exemptions below.

**Rationale:** User chose full-repo error for this PR. Remaining primitive classes are ~20 product files plus a handful of overlays/`bg-black`.

### 4. CSS is generated; JSON is canonical

**Decision:** Paths:

```text
design/tokens/
  primitive.json
  semantic.json
  domain.json
  experience/web.json
  experience/app.json
design/scripts/generate-tokens.mjs
design/generated/
  web.css              # :root / .dark custom props + @theme color bridges
  lint-metadata.json   # layer + suggestions per Tailwind id
  app.ts               # typed App experience stub (unused by Web)
```

Generated files are **committed**. `just tokens-check` regenerates in a temp dir and fails if the tree is dirty. Product components never import `design/tokens/**` at runtime.

`web/src/index.css` `@import`s `../../design/generated/web.css` (repo-root relative from `web/src/`). Vite/`@tailwindcss/vite` must resolve that path; do not copy token values into `index.css`. Hand-written `--agent-online` etc. in `index.css` **move** into the generated file.

### 5. Semantic aliases keep shadcn class names working

**Decision:** Generated CSS still sets `--background`, `--foreground`, `--destructive`, `--muted-foreground`, … so existing `bg-background` / `text-destructive` keep working. New semantic names used by migrated product code:

| Token | Typical replacement for |
|-------|-------------------------|
| `success` | `green-500`, `green-400`, `emerald-500` status |
| `warning` | `amber-*`, `yellow-*` |
| `info` | `blue-*` banners, folder icons, “authenticated” badge |
| `overlay` | modal/sheet/side-panel `bg-black/*` scrims |
| `inverse` | media letterbox (`bg-black` behind image/video/preview) |

Domain tokens stay the #468 set (`agent.*`, `session.*`, `attachment.*`, `terminal.*`, `workspace.*`, `file.*`, `editor.*`). Missing CSS stops that the slice currently falls back to `text-muted-foreground` (`session.unknown`, `attachment.attaching`, `attachment.detached`, `agent.connecting`, `agent.reconnecting`) **must be generated** even if they alias muted-foreground.

### 6. Client WebSocket badge ≠ Agent channel

**Decision:** `ConnectionStatusBadge` (`disconnected` / `connecting` / `connected` / `authenticated`) uses **semantic** `danger`/`warning`/`success`/`info`, not `agent.*`.

**Rationale:** That widget is the browser’s socket to nession-server, not the remote tmux proxy.

### 7. xterm Catppuccin stays hex in `ThemeManager`

**Decision:** Plugin **ignores** `web/src/terminal/ThemeManager.ts` and `web/src/terminal/__tests__/unit/ThemeManager.test.ts`. Do not encode Catppuccin as UI primitives. Optional later: generate an xterm theme from `terminal.*` domain tokens — **out of this PR**.

**Rationale:** xterm `ITheme` requires CSS color strings. Terminal theme is independent of the Zinc UI theme (existing product decision).

### 8. `bg-black` / `text-white` / Tailwind default palettes are primitive

**Decision:** The rule flags at least:

- Palette utilities: `red`, `green`, `blue`, `yellow`, `amber`, `orange`, `emerald`, `teal`, `cyan`, `sky`, `indigo`, `violet`, `purple`, `fuchsia`, `pink`, `rose`, `zinc`, `neutral`, `slate`, `gray`, `stone`, `lime`, `black`, `white` (any prefix `text|bg|border|ring|from|to|via|fill|stroke|outline|decoration|accent|caret|divide|shadow`)
- Opacity suffixes (`bg-green-500/30`) still count as that primitive
- Arbitrary values: `bg-[#fff]`, `text-[rgb(...)]`, `border-[oklch(...)]`
- Inline `style={{ color: '#…' | 'rgb(…)' | 'oklch(…)' }}` (and background/borderColor)
- Direct primitive CSS variables if codegen emits any (`var(--primitive-green-500)` / `var(--n-green-500)`)

Allowed: `bg-background`, `text-muted-foreground`, `text-destructive`, `border-success/30`, `text-agent-online`, `bg-overlay`, `bg-inverse`, `prose-*` only when the color piece is a semantic token (today `prose-a:text-blue-300` **fails** and must become `prose-a:text-info` or equivalent).

`components/ui/**` is **not** exempt. Overlay scrims become `bg-overlay`.

### 9. Cross-experience rule ships, Web cannot see App classes

**Decision:** `experience/app.json` exists (density / touchTarget / safe-area schema from #467). `web.css` emits **only** `experience.web`. `nession/no-cross-experience-token` errors if Web TSX uses App-prefixed utilities (e.g. `touch-target-min`, `control-app-md` — exact generated names documented in lint-metadata). No App package consumes `app.ts` yet.

### 10. Tests are product code

**Decision:** Fixtures and integration tests that query `.text-amber-500` / `bg-blue-500` are updated to the new class. `cn()` unit tests may use a fake non-palette class (`btn-primary`) instead of `bg-blue-500`.

---

## Architecture

```text
design/tokens/*.json
        │
        ▼
design/scripts/generate-tokens.mjs
        │
        ├── design/generated/web.css          ← index.css imports
        ├── design/generated/lint-metadata.json
        └── design/generated/app.ts
                │
                ▼
web/eslint-plugin-nession  ──reads──► lint-metadata.json
                │
                ▼
eslint.config.js  (error, --max-warnings 0)
```

Local plugin lives at `web/eslint-plugin-nession/` (ESLint 9 flat config `plugins: { nession: … }`). Rule tests/fixtures sit next to the plugin (`web/eslint-plugin-nession/__tests__/`).

`just tokens-gen` writes generated files. `just tokens-check` is part of `just web-lint` (or a prerequisite) so CI cannot drift.

---

## JSON shape (locked)

Layer files are JSON objects with `$description` optional. References use `{ "ref": "primitive.color.green.500" }` or `{ "value": "oklch(...)" }` only inside **primitive**. Semantic/domain/experience must `ref` (or ref another semantic/domain), never embed a raw hex/oklch except via primitive.

**primitive.json** — palette/scales only. At minimum the stops required to express current `:root` / `.dark` and the success/warning/info/overlay/inverse hues. No AI-runtime names.

**semantic.json** — `background`, `foreground`, `surface` (if needed as aliases of card/sidebar), `text.primary|secondary|tertiary`, `border.subtle|default|strong`, `accent`, `success`, `warning`, `danger` (destructive), `info`, `overlay`, `inverse`. Light and dark are two resolution maps, not duplicated component CSS.

**domain.json** — exact names from `docs/design/design-system/tokens.md`. Agent / session / attachment stay independent.

**experience/web.json** — `control.sm|md|lg`, `row.sm|md|lg`, `icon.sm|md`, `panel.padding` as **size** tokens (px). Generated as CSS variables, not as an excuse to rewrite every Button this PR. Size tokens are not color primitives; the color rule does not flag `h-8`.

**experience/app.json** — schema + values from the issue (44px touch target, etc.). Not imported by Web CSS.

---

## Product color mapping (this PR)

Replace in place; do not restyle.

| Location | From | To |
|----------|------|----|
| `AgentCard` online border | `border-green-500/30` | `border-agent-online/30` |
| `SessionList` / `SessionPanel` / `SessionDropdown` dots | `bg-green-500` / `bg-emerald-500/60` / `bg-gray-400` | Wire `active` → `bg-session-active`; wire `detached` (tmux alive, client not attached) → `bg-session-active/60`; otherwise → `bg-session-unknown`. Never Agent-offline color on a session row that still exists. |
| `AgentDetailPanel` health / session pills | `text-green-400`, `bg-red-500/10`, … | Agent reachability → `agent.*`; tmux row → `session.*`; generic healthy/poor if it is **heartbeat age** → `success` / `warning` / `danger` (semantic), not `session.*` |
| `ConnectionStatusBadge` | `bg-red-500` etc. | `bg-destructive` / `bg-warning` / `bg-success` / `bg-info` |
| `AddressSelector` / `AttachDialog` reachability | `text-green-500` / `text-red-500` / `text-amber-500` | `text-success` / `text-destructive` / `text-warning` |
| `LoginPage` check | `text-green-500` | `text-success` |
| `EnvDiff` | `emerald` / `red` | `file.created` / `file.deleted` (or `success`/`destructive` if we treat env lines as generic diff — **prefer file.created/deleted**) |
| `EnvInlineEditor` / `EnvEditorDialog` warnings | `amber-*` | `text-warning` |
| `EnvPanel` applied | `text-emerald-500` | `text-success` |
| `FileViewer` dirty / banners | `amber-*` / `blue-*` | `file.modified` / `info` |
| `FileTabs` dirty | `bg-amber-500` | `bg-file-modified` |
| `FileBrowser` folder | `text-blue-400` | `text-info` |
| `MarkdownPreview` banners / links | `blue-*` | `info` |
| `ConfigViewer` JSON tint | `text-amber-400` | `text-warning` |
| `TerminalBanner` (both) | `bg-yellow-600` / `bg-red-600` / `text-white` | `bg-warning` / `bg-destructive` + `text-warning-foreground` / `text-destructive-foreground` |
| shadcn overlay `bg-black/10` `/80` | primitive black | `bg-overlay` (alpha via token or `/10` on overlay) |
| `SidePanel` / `ImageViewer` / `VideoViewer` / `SessionPreviewDialog` letterbox | `bg-black/*` | `bg-overlay` (chrome) or `bg-inverse` (media) |

Session-first patterns already use `text-agent-online` etc.; after codegen they must resolve through generated CSS, not leftover hand vars in `index.css`.

---

## Error handling / drift

- Hand-editing `design/generated/**` is a CI failure (`tokens-check`).
- Missing `ref` target in JSON → codegen exits non-zero.
- Introducing `agent.thinking` or other AI-runtime ids → **do not add**; codegen has no such keys; lint metadata will not suggest them.

---

## Testing

1. **Codegen unit tests** (`design/scripts/__tests__/` or Node `node:test`): ref resolution, light/dark emission, no raw oklch in domain.json.
2. **ESLint rule fixtures** (valid: `text-agent-online`, `bg-background`; invalid: `text-green-500`, `bg-[#fff]`, `style={{ color: '#fff' }}`, `bg-black/40`). Message includes a suggested semantic/domain replacement from metadata.
3. **Cross-experience fixture:** Web file with an App utility → error.
4. **Existing Vitest:** update class assertions; `just web-test` + coverage thresholds unchanged.
5. **Playwright (mandatory for UI):** staging-lookalike local demo — flag-off Dashboard AgentCard online border + flag-on Session-first list/Agent channel still readable; screenshot in PR comment. No visual redesign means screenshots should match current density/colors, not a new theme.

---

## Non-goals

- Indigo accent / new surface.0–3 ladder as a visual change.
- Encoding Workspace tool IA or App swipe model as tokens.
- Replacing Tailwind / shadcn / Base UI.
- Migrating Session-first shell to default (#472).
- Native App consuming `app.ts`.
- Parsing Claude/Codex into Domain tokens.
- `crates/**` / protocol.
- `k8s/overlays/**` on this branch.

---

## PR / CI

- PR base: **staging**.
- `just web-lint` includes token drift check + ESLint errors for primitives.
- Body: 变更内容 + 测试报告; no `Closes #467` (close on release PR).
- Issue #467 in 变更内容; screenshots in a PR comment.
