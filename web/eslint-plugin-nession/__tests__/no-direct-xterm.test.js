import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import nessionPlugin from '../index.js';

// #2581 SC-02. The Xterm Engine boundary, made mechanical: Product/UI may
// import the business-neutral emulator port, never xterm itself, the engine
// adapter module, or its private `_core`. Each rejected shape below is a real
// way the old boundary leaked:
//
//   - `FixtureTerminal` constructed `new Terminal()` in `app/`;
//   - `TerminalViewport` imported `@xterm/xterm` types to register a link
//     provider through `controller.terminal`;
//   - `grid.ts` read `_core._renderService` outside any single adapter.
//
// The positive fixtures are equally load-bearing: the engine owner must still
// be able to import xterm, and the one metrics adapter must still be able to
// read `_core`, or the rule would be satisfied by not having an engine.
const RULE = nessionPlugin.rules['no-direct-xterm'];
const SRC = '/p/web/src/';
const PRODUCT = `${SRC}product/terminal/components/TerminalViewport.tsx`;
const ENGINE = `${SRC}platform/terminal-runtime/xterm/XtermEmulator.ts`;
const METRICS = `${SRC}platform/terminal-runtime/xterm/XtermMetrics.ts`;
const FIXTURE = `${SRC}app/fixture/FixtureTerminal.tsx`;
const CONTROLLER = `${SRC}platform/terminal-runtime/controller/TerminalController.ts`;

// RuleTester (ESLint 8) silently falls back to espree unless `parser` is an
// absolute path, so the fixtures below stay plain JavaScript; the boundary
// under test is import/`. _core` access, not TypeScript syntax.
const ruleTester = new RuleTester({
  parserOptions: { ecmaVersion: 2020, sourceType: 'module', ecmaFeatures: { jsx: true } },
});

test('no-direct-xterm keeps raw xterm inside the engine', () => {
  ruleTester.run('no-direct-xterm', RULE, {
    valid: [
      // The engine owner is xterm's production owner.
      { code: "import { Terminal } from '@xterm/xterm';", filename: ENGINE },
      { code: "import { WebglAddon } from '@xterm/addon-webgl';", filename: ENGINE },
      // The single compatibility adapter may read the private render service.
      {
        code: "const cell = terminal._core._renderService.dimensions;",
        filename: METRICS,
      },
      // Product/UI consumes the port — no xterm, no engine module.
      {
        code: "import { TerminalLinkMatcher } from '@/platform/terminal-runtime/emulator';",
        filename: PRODUCT,
      },
      // The canonical fixture consumes the public engine barrel (SC-10).
      {
        code: "import { createTerminalEmulator } from '@/platform/terminal-runtime/xterm';",
        filename: FIXTURE,
      },
      // Platform runtime may compose the engine.
      {
        code: "import { XtermEmulator } from '../xterm/XtermEmulator';",
        filename: CONTROLLER,
      },
      // Test files are not shipped.
      { code: "import { Terminal } from '@xterm/xterm';", filename: `${SRC}product/terminal/__tests__/x.test.ts` },
      { code: "const cell = t._core;", filename: `${SRC}platform/terminal-runtime/__tests__/unit/x.test.ts` },
    ],
    invalid: [
      {
        // The shape FixtureTerminal used to have.
        code: "import { Terminal } from '@xterm/xterm';",
        filename: PRODUCT,
        errors: [{ messageId: 'rawImport' }],
      },
      {
        code: "import { CanvasAddon } from '@xterm/addon-canvas';",
        filename: PRODUCT,
        errors: [{ messageId: 'rawImport' }],
      },
      {
        // The shape TerminalViewport used to have: reaching the engine module
        // from Product is how a raw Terminal becomes reachable again.
        code: "import { XtermEmulator } from '@/platform/terminal-runtime/xterm/XtermEmulator';",
        filename: PRODUCT,
        errors: [{ messageId: 'engineImport' }],
      },
      {
        code: "import { createTerminalEmulator } from '../../../platform/terminal-runtime/xterm';",
        filename: PRODUCT,
        errors: [{ messageId: 'engineImport' }],
      },
      {
        // The fixture may use the barrel, not the raw adapter.
        code: "import { XtermEmulator } from '@/platform/terminal-runtime/xterm/XtermEmulator';",
        filename: FIXTURE,
        errors: [{ messageId: 'engineImport' }],
      },
      {
        // The shape grid.ts had: a platform module other than the metrics
        // adapter reaching into xterm's private render service.
        code: "const cell = t._core._renderService.dimensions.css.cell;",
        filename: `${SRC}platform/terminal-runtime/grid.ts`,
        errors: [{ messageId: 'privateCore' }],
      },
      {
        code: "const cell = t['_core']._renderService;",
        filename: METRICS.replace('XtermMetrics.ts', 'XtermRenderer.ts'),
        errors: [{ messageId: 'privateCore' }],
      },
      {
        code: "import { Terminal } from '@xterm/xterm';",
        filename: `${SRC}app/ShellMain.tsx`,
        errors: [{ messageId: 'rawImport' }],
      },
    ],
  });
});

test('the violation names the owner and the repair', () => {
  const reported = [];
  const context = {
    filename: PRODUCT,
    report(descriptor) {
      reported.push(descriptor);
    },
    getFilename() {
      return PRODUCT;
    },
  };
  RULE.create(context).ImportDeclaration({
    source: { value: '@xterm/xterm' },
  });

  assert.equal(reported.length, 1);
  const message = RULE.meta.messages[reported[0].messageId].replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => reported[0].data[key],
  );
  assert.match(message, /@xterm/);
  assert.match(message, /owner: {2}web\/src\/platform\/terminal-runtime\/xterm\//);
  assert.match(message, /repair:/);
  assert.match(message, /nession\/no-direct-xterm/);
});
