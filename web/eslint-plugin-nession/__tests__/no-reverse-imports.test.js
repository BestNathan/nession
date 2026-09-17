import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import nessionPlugin from '../index.js';

// #783. This rule is the mechanical half of the layer direction `web/CLAUDE.md`
// states, and it had never fired: `getSourceLayer` read the *import path* to
// decide the source layer — the same input `getTargetLayer` reads — so for any
// `@/` alias both returned the layer of the target and the mismatch check
// short-circuited. Every cross-layer import here uses `@/`, so nothing was ever
// reported. The fixtures below are what make its silence mean something.
//
// #788 then found the second half of the same failure: the rule visited only
// `ImportDeclaration`, so the identical edge written as `export … from` was
// never examined. Both gaps are one thing — coverage narrower than the claim.
const ruleTester = new RuleTester({
  parser: tseslint.parser,
  parserOptions: { ecmaVersion: 2020, sourceType: 'module', ecmaFeatures: { jsx: true } },
});

test('no-reverse-imports enforces the layer direction on aliased imports', () => {
  ruleTester.run('no-reverse-imports', nessionPlugin.rules['no-reverse-imports'], {
    valid: [
      // app may reach everything below it.
      { code: "import { Badge } from '@/components/ui/badge';", filename: '/p/web/src/app/LoginPage.tsx' },
      { code: "import { x } from '@/features/files/model/x';", filename: '/p/web/src/app/LoginPage.tsx' },
      // features may reach core and shared.
      { code: "import { x } from '@/services/socket';", filename: '/p/web/src/features/files/F.tsx' },
      { code: "import { cn } from '@/lib/utils';", filename: '/p/web/src/features/files/F.tsx' },
      // core may reach shared.
      { code: "import { cn } from '@/lib/utils';", filename: '/p/web/src/services/socket/probe.ts' },
      // same-layer is always fine.
      { code: "import { Badge } from '@/components/ui/badge';", filename: '/p/web/src/components/ui/probe.tsx' },
      { code: "import { x } from '@/features/files/model/x';", filename: '/p/web/src/features/files/F.tsx' },
      // External packages are not this rule's business.
      { code: "import * as React from 'react';", filename: '/p/web/src/components/ui/probe.tsx' },
    ],
    invalid: [
      {
        // The shape that shipped: a generic primitive reaching into a service.
        code: "import { ConnectionState } from '@/services/socket';",
        filename: '/p/web/src/components/ui/ConnectionStatusBadge.tsx',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        // shared must not reach product features either.
        code: "import { SessionItem } from '@/features/sessions/components/SessionItem';",
        filename: '/p/web/src/components/ui/probe.tsx',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        // The cycle #783 found: core reaching a feature that consumes core.
        code: "import { createTerminalAgentApi } from '@/features/terminal';",
        filename: '/p/web/src/runtime/SessionRuntime.ts',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        // The one upward inversion in the tree.
        code: "import { capsulePresence } from '@/app/capsulePresence';",
        filename: '/p/web/src/features/terminal/TerminalSurface.tsx',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        code: "import { orderAddressesByLatency } from '@/services/addressSelection';",
        filename: '/p/web/src/shared/hooks/useAddressPlan.ts',
        errors: [{ messageId: 'reverseImport' }],
      },
    ],
  });
});

// Two exemptions, both deliberate, and both easy to widen by accident later —
// so they are pinned rather than left as comments in the rule.
test('the rule reports the runtime graph only: test files are out of scope', () => {
  ruleTester.run('no-reverse-imports', nessionPlugin.rules['no-reverse-imports'], {
    valid: [
      {
        // A test wiring several layers to exercise something is doing its job;
        // it is not part of the shipped graph.
        code: "import { terminalServerApi } from '@/features/terminal';",
        filename: '/p/web/src/services/__tests__/integration/websocket.test.ts',
      },
      {
        code: "import { createFilesApi } from '@/features/files';",
        filename: '/p/web/src/runtime/__tests__/unit/SessionRuntime.test.ts',
      },
      {
        code: "import { x } from '@/features/files/model/x';",
        filename: '/p/web/src/shared/hooks/thing.test.tsx',
      },
    ],
    // …but the same import from a shipped file in the same directory still fails,
    // so the exemption is about the file's role, not its folder.
    invalid: [
      {
        code: "import { createFilesApi } from '@/features/files';",
        filename: '/p/web/src/runtime/SessionRuntime.ts',
        errors: [{ messageId: 'reverseImport' }],
      },
    ],
  });
});

// Driven directly rather than through RuleTester: this RuleTester runs in the
// legacy config where the TypeScript parser is not applied, so `import type`
// does not parse. Asserting on the visitor is the stronger test anyway — it
// pins the exemption itself rather than the parser's ability to express it.
test('a fully-erased type import is out of scope — it creates no runtime edge', () => {
  const rule = nessionPlugin.rules['no-reverse-imports'];

  function reportFor(importKind) {
    const reported = [];
    const visitors = rule.create({
      getFilename: () => '/p/web/src/runtime/SessionRuntime.ts',
      report: (d) => reported.push(d),
    });
    visitors.ImportDeclaration({
      importKind,
      source: { value: '@/features/terminal' },
    });
    return reported;
  }

  assert.equal(reportFor('type').length, 0, 'import type must be exempt');
  // `import { type X }` is a VALUE import statement — it emits a module
  // reference, so it stays in scope. Only the fully-erased form is exempt.
  assert.equal(reportFor('value').length, 1, 'a value import must still be reported');
});

// #788. The rule had only an ImportDeclaration visitor, so a wrong-direction
// re-export — the same runtime edge by a different keyword — passed silently.
// These are the fixtures that make the new visitors' silence mean something.
test('a re-export is the same runtime edge as an import', () => {
  ruleTester.run('no-reverse-imports', nessionPlugin.rules['no-reverse-imports'], {
    valid: [
      // Legal directions behave exactly as the import form does.
      { code: "export { Badge } from '@/components/ui/badge';", filename: '/p/web/src/app/LoginPage.tsx' },
      { code: "export { probe } from '@/services/socket';", filename: '/p/web/src/features/files/F.tsx' },
      // A local re-export references no other module. The binding has to exist
      // for the parser to accept the statement at all.
      {
        code: 'const localThing = 1;\nexport { localThing };',
        filename: '/p/web/src/components/ui/probe.tsx',
      },
      // External packages are not this rule's business.
      { code: "export * from 'react';", filename: '/p/web/src/components/ui/probe.tsx' },
    ],
    invalid: [
      {
        // The shape #788 was filed for: a shared primitive re-exporting product
        // code, which pulls the feature into the bundle just as `import` would.
        code: "export { SessionItem } from '@/features/sessions/components/SessionItem';",
        filename: '/p/web/src/components/ui/probe.tsx',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        // `export *` carries a whole module graph — an edge like any other.
        code: "export * from '@/features/terminal';",
        filename: '/p/web/src/services/socket/probe.ts',
        errors: [{ messageId: 'reverseImport' }],
      },
    ],
  });
});

// Driven directly for the same reason as the import case above: `export type`
// does not parse in the legacy RuleTester's plain-ESM mode.
test('a fully-erased type re-export is out of scope, and a local export is not an edge', () => {
  const rule = nessionPlugin.rules['no-reverse-imports'];

  function reportFor(visitorName, node) {
    const reported = [];
    const visitors = rule.create({
      getFilename: () => '/p/web/src/components/ui/probe.tsx',
      report: (d) => reported.push(d),
    });
    visitors[visitorName](node);
    return reported;
  }

  const source = { value: '@/features/terminal' };

  assert.equal(
    reportFor('ExportNamedDeclaration', { source, exportKind: 'type', specifiers: [] }).length,
    0,
    'export type { X } from must be exempt',
  );
  assert.equal(
    reportFor('ExportNamedDeclaration', { source, exportKind: 'value', specifiers: [] }).length,
    1,
    'a value re-export must still be reported',
  );
  assert.equal(
    reportFor('ExportAllDeclaration', { source, exportKind: 'type' }).length,
    0,
    'export type * from must be exempt',
  );
  assert.equal(
    reportFor('ExportAllDeclaration', { source, exportKind: 'value' }).length,
    1,
    'export * from must still be reported',
  );
  assert.equal(
    reportFor('ExportNamedDeclaration', { source: null, exportKind: 'value', specifiers: [] }).length,
    0,
    'a local export { x } references no module',
  );
});
