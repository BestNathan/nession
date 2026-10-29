# Xterm Engine and Terminal component ownership (#2581)

> Requirement: [GitHub #2581](https://github.com/BestNathan/nession/issues/2581).
> Upstream constraints: [session-runtime-ownership.md](../design/terminal/session-runtime-ownership.md)
> (#1309), [interaction-semantics.md](../design/terminal/interaction-semantics.md)
> (#1096), [terminal-sizing.md](../design/terminal/terminal-sizing.md) (#2487),
> [multi-client-ownership.md](../design/terminal/multi-client-ownership.md)
> (#2286). This document owns the **emulator-adapter / component boundary**; it
> does not reopen any of those correctness models.

Nession's Web terminal has one business-neutral **Xterm Engine** inside
`web/src/platform/terminal-runtime/xterm/`. It is the only production owner of
an `@xterm/xterm` `Terminal` instance. Product/UI consumes a narrow port; it
never imports xterm, the raw adapter module, or xterm's private `_core`.

## Current writable owners

| Responsibility | Canonical owner | Consumers |
|---|---|---|
| Session route / attach / lease / stream synchronization / ACK | `platform/session-runtime/SessionRuntime` (+ existing transports) | `TerminalController` observes; it decides nothing |
| The xterm instance, mount/reparent/unmount/dispose, renderer, theme, addons | `platform/terminal-runtime/xterm/XtermEmulator` (port: `platform/terminal-runtime/emulator.ts`) | `TerminalController`, `FixtureTerminal` |
| Measured cell / buffer / mode / logical-line read models, private `_core` | `platform/terminal-runtime/xterm/XtermMetrics.ts` — the ONE compatibility adapter | the engine only |
| Ordered buffer/grid mutation (write, resize, dedupe) | `controller/SerializedTerminalWriter.ts` | `TerminalController` |
| Fixed-column geometry, font fit, rows, content-width value, PTY resize report/debounce | `view/TerminalGeometry.ts` | `TerminalController` (writes the viewport CSS property) |
| PTY-bound input semantics (keyboard, semantic keys, paste, IME text) | `interaction/TerminalInteractionController.ts` | input handlers, capsule, mobile IME |
| Workspace file-link recognition and navigation action | `product/terminal/workspaceFileLinks.ts` | `TerminalViewport` → emulator matcher |
| Link cell mapping, buffer-line wrap joining | `xterm/LineLinks.ts` + `XtermMetrics.ts` | the engine |

The mutable engine surface (`write`/`resize`) is reachable only through the
adapter module. Product/UI cannot import that module, so it cannot bypass the
ordered writer.

## Final dependency graph

```text
app / product / capabilities
  │  import only: @/platform/terminal-runtime/emulator (the port)
  │               TerminalController's typed methods (attach, registerLinkMatcher, …)
  ▼
platform/terminal-runtime
  ├── controller/TerminalController.ts   composition: attach/detach, wiring, viewport facts
  │     ├── view/TerminalGeometry.ts     fixed cols, measured-cell font fit, rows, debounce
  │     ├── controller/SerializedTerminalWriter.ts   sole FIFO of xterm mutation
  │     ├── interaction/TerminalInteractionController.ts
  │     ├── input/MobileImeInput.ts      reads cursor/cell through the port
  │     └── capsule/occlusionScroll.ts   reads buffer/modes through the port
  ├── xterm/xterm adapter (the only @xterm/* importer)
  │     ├── XtermEmulator.ts             Terminal construction, mount/unmount/dispose
  │     ├── XtermMetrics.ts              `_core` cell read + buffer/mode/logical-line models
  │     ├── XtermRenderer.ts             WebGL/Canvas lifecycle and failure fallback
  │     ├── XtermAddonHost.ts            addon registration/lookup/single disposal
  │     └── LineLinks.ts                 UTF-16 offsets → buffer cells (wide/combining/wrap)
  └── webglSupport.ts                    xterm-free capability probe (attach dialog)
```

`app/fixture/FixtureTerminal.tsx` imports the engine's **public barrel**
(`@/platform/terminal-runtime/xterm`) and therefore constructs its terminal
through the same renderer/theme/metrics rules as the product (#2581 SC-10).
It selects the engine's `dom` renderer so the buffer text stays in
`.xterm-rows` for the canonical screens and their text assertions. No other
app/product file may import that barrel.

## Machine-checked boundary

`nession/no-direct-xterm` (`web/eslint-plugin-nession/rules/no-direct-xterm.js`,
enabled in `web/eslint.config.js`) rejects:

1. `@xterm/*` imports outside `platform/terminal-runtime/xterm/`;
2. imports of the engine modules from Product/UI (the fixture may use only the
   public barrel);
3. `_core` member access anywhere except `XtermMetrics.ts`.

Its negative fixtures (`web/eslint-plugin-nession/__tests__/no-direct-xterm.test.js`)
prove each rejected shape, and the positive fixtures prove the engine owner and
the metrics adapter still pass. Test files are exempt, as they are not shipped.

## Preserved invariants

- `SerializedTerminalWriter` keeps its FIFO, bounds, parser-completed callbacks,
  halt/replacement semantics and generation guards. The only change is that a
  resize repeating the grid it already applied does not call `xterm.resize`
  again; the operation stays in FIFO order so its callback cannot overtake an
  earlier write (#2581 SC-06).
- `TerminalGeometry` recomputes the font fit only when the observed width
  changes. Height-only observations reuse the measured cell and recompute rows.
- Bootstrap fidelity, old-generation rejection, applied-cursor ACK eligibility,
  overflow repair and reparent scrollback are unchanged; SessionRuntime remains
  the authority for stream synchronization.
- All emulator subscriptions/addons are typed disposables. A halted writer
  replaces the emulator; the controller re-installs link matchers on the
  replacement and disposes each subscription exactly once.

## Tests

- `xterm/__tests__/unit/XtermMetrics.test.ts` — measured cell, fallback, hostile `_core`.
- `xterm/__tests__/integration/XtermMetricsLines.test.ts` — logical lines: trim, wide,
  combining, wrap join, continuation refusal.
- `xterm/__tests__/unit/LineLinks.test.ts` — offset → cell mapping for ASCII,
  wide, combining, wrapped and out-of-range matches.
- `xterm/__tests__/integration/XtermEmulator.test.ts` — mount/unmount preserves
  scrollback.
- `controller/__tests__/unit/SerializedTerminalWriter.test.ts` — FIFO, bounds,
  parser completion, repeated-resize dedupe.
- `view/__tests__/unit/TerminalGeometry.test.ts` — width-only font fit,
  height-only rows, unchanged-grid report dedupe.
- `product/terminal/__tests__/unit/workspaceFileLinks.test.ts` — recognition,
  offsets, matcher activation.
- Template/behavioral regressions continue to run under `web-test-unit`,
  `web-test-integration`, `web-typecheck`, `web-eslint` and the existing
  terminal browser suites.
