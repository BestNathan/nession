import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import nessionPlugin from '../index.js';
import {
  LEGACY_TO_LAYER,
  NON_LAYER_DIRS,
  ROOT_FILE_LAYER,
} from '../rules/no-reverse-imports.js';

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
      { code: "import { x } from '@/capabilities/files/model/x';", filename: '/p/web/src/app/LoginPage.tsx' },
      // capabilities may reach core and shared.
      { code: "import { x } from '@/services/socket';", filename: '/p/web/src/capabilities/files/F.tsx' },
      { code: "import { cn } from '@/lib/utils';", filename: '/p/web/src/capabilities/files/F.tsx' },
      // core may reach shared.
      { code: "import { cn } from '@/lib/utils';", filename: '/p/web/src/services/socket/probe.ts' },
      // same-layer is always fine.
      { code: "import { Badge } from '@/components/ui/badge';", filename: '/p/web/src/components/ui/probe.tsx' },
      { code: "import { x } from '@/capabilities/files/model/x';", filename: '/p/web/src/capabilities/files/F.tsx' },
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
        // shared must not reach product either.
        code: "import { SessionItem } from '@/product/sessions/components/SessionItem';",
        filename: '/p/web/src/components/ui/probe.tsx',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        // The cycle #783 found: core reaching a feature that consumes core.
        code: "import { createTerminalAgentApi } from '@/product/terminal';",
        filename: '/p/web/src/runtime/SessionRuntime.ts',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        // The one upward inversion in the tree.
        code: "import { capsulePresence } from '@/app/capsulePresence';",
        filename: '/p/web/src/product/terminal/TerminalSurface.tsx',
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
        code: "import { terminalServerApi } from '@/product/terminal';",
        filename: '/p/web/src/services/__tests__/integration/websocket.test.ts',
      },
      {
        code: "import { createFilesApi } from '@/capabilities/files';",
        filename: '/p/web/src/runtime/__tests__/unit/SessionRuntime.test.ts',
      },
      {
        code: "import { x } from '@/capabilities/files/model/x';",
        filename: '/p/web/src/shared/hooks/thing.test.tsx',
      },
    ],
    // …but the same import from a shipped file in the same directory still fails,
    // so the exemption is about the file's role, not its folder.
    invalid: [
      {
        code: "import { createFilesApi } from '@/capabilities/files';",
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
      source: { value: '@/product/terminal' },
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
      { code: "export { probe } from '@/services/socket';", filename: '/p/web/src/capabilities/files/F.tsx' },
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
        code: "export { SessionItem } from '@/product/sessions/components/SessionItem';",
        filename: '/p/web/src/components/ui/probe.tsx',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        // `export *` carries a whole module graph — an edge like any other.
        code: "export * from '@/product/terminal';",
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

  const source = { value: '@/product/terminal' };

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

// #791. The third syntax for the same runtime edge. `import()` is ES2020, so
// unlike `export type` it parses in the legacy RuleTester and needs no
// direct-visitor workaround.
test('a dynamic import is the same runtime edge as a static one', () => {
  ruleTester.run('no-reverse-imports', nessionPlugin.rules['no-reverse-imports'], {
    valid: [
      { code: "import('@/lib/encoding');", filename: '/p/web/src/capabilities/files/F.tsx' },
      { code: "import('react');", filename: '/p/web/src/components/ui/probe.tsx' },
    ],
    invalid: [
      {
        code: "import('@/product/terminal');",
        filename: '/p/web/src/components/ui/probe.tsx',
        errors: [{ messageId: 'reverseImport' }],
      },
    ],
  });
});

// `node.source` on an ImportExpression is an expression, not a Literal, so a
// computed specifier reaches the rule as an Identifier. It names nothing
// statically resolvable — the rule must not guess, and must not crash.
test('a computed dynamic import names nothing and is left alone', () => {
  const rule = nessionPlugin.rules['no-reverse-imports'];
  const reported = [];
  const visitors = rule.create({
    getFilename: () => '/p/web/src/components/ui/probe.tsx',
    report: (d) => reported.push(d),
  });

  visitors.ImportExpression({ source: { type: 'Identifier', name: 'someVar' } });
  assert.equal(reported.length, 0, 'a non-literal source is not statically resolvable');

  // Same call with a resolvable literal must report, so the assertion above is
  // about the specifier and not about the visitor being inert.
  visitors.ImportExpression({ source: { type: 'Literal', value: '@/product/terminal' } });
  assert.equal(reported.length, 1, 'a literal source is still an edge');
});

// #801 Phase 1 ("正确解析 relative imports"). `getTargetLayer` handled `@/…`
// only, so every relative specifier fell to `unknown` — which `checkRuntimeEdge`
// skips. The same reverse import was therefore caught when written with an alias
// and invisible when written with a path, and both spellings occur in the tree.
// `web/src/services/deepLinkAttach.ts` was shipping the second kind.
test('a relative specifier is resolved against the importing file', () => {
  ruleTester.run('no-reverse-imports', nessionPlugin.rules['no-reverse-imports'], {
    valid: [
      // Downward and same-layer are legal, however they are spelled.
      { code: "import { probe } from '../lib/probe';", filename: '/p/web/src/services/thing.ts' },
      { code: "import { helper } from './helper';", filename: '/p/web/src/services/thing.ts' },
      { code: "import { sibling } from './sibling';", filename: '/p/web/src/components/ui/probe.tsx' },
      // A specifier that climbs out of every layer names nothing placeable.
      { code: "import { x } from '../../../../outside';", filename: '/p/web/src/services/thing.ts' },
    ],
    invalid: [
      {
        // The shape that was shipping: `core` reaching a feature by path.
        code: "import { sessionsApi } from '../product/sessions';",
        filename: '/p/web/src/services/deepLinkAttach.ts',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        code: "import { x } from '../../product/terminal';",
        filename: '/p/web/src/components/ui/probe.tsx',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        // `shared` may not reach a feature either, and the path climbs two
        // levels — the resolution, not the spelling, is what is under test.
        code: "import { x } from '../capabilities/files';",
        filename: '/p/web/src/lib/thing.ts',
        errors: [{ messageId: 'reverseImport' }],
      },
    ],
  });
});

// #801's first target layer. `product` is a module that means something in
// Nession's product vocabulary rather than one that merely implements
// something: `app` composes it, and the generic primitives it composes must not
// reach back into it. Which concepts have moved and which have not is the
// migration map in `docs/architecture/web.md` — not this table, which states
// the destination.
test('the product layer sits below app and above the primitives', () => {
  ruleTester.run('no-reverse-imports', nessionPlugin.rules['no-reverse-imports'], {
    valid: [
      // app composes product.
      {
        code: "import { SurfaceSwitcher } from '@/product/workspace/patterns/SurfaceSwitcher';",
        filename: '/p/web/src/app/SessionFirstMain.tsx',
      },
      // product composes primitives and shared helpers.
      {
        code: "import { Tabs } from '@/components/ui/tabs';",
        filename: '/p/web/src/product/workspace/patterns/SurfaceSwitcher.tsx',
      },
      {
        code: "import { cn } from '@/lib/utils';",
        filename: '/p/web/src/product/workspace/patterns/SurfaceSwitcher.tsx',
      },
      // same layer is always fine.
      {
        code: "import { SessionItem } from '@/product/session/patterns/SessionItem';",
        filename: '/p/web/src/product/session/patterns/SessionList.tsx',
      },
    ],
    invalid: [
      {
        // A generic primitive may not know what a Workspace is.
        code: "import { SurfaceSwitcher } from '@/product/workspace/patterns/SurfaceSwitcher';",
        filename: '/p/web/src/components/ui/probe.tsx',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        // product may not reach up into the shell that composes it.
        code: "import { shellIconButtonClass } from '@/app/shellStyles';",
        filename: '/p/web/src/product/workspace/patterns/SurfaceSwitcher.tsx',
        errors: [{ messageId: 'reverseImport' }],
      },
    ],
  });
});

// `features/` is gone, so the migration allowance that existed to let it be
// drained is gone too — and this is the assertion that keeps it gone. A fixture
// for the allowance would be a fixture for a rule that no longer exists; what is
// worth pinning instead is that a `features/` path is now **unclassifiable**, so
// the old spelling cannot quietly pass as a known layer.
test('the former features/ paths are no longer a layer', () => {
  ruleTester.run('no-reverse-imports', nessionPlugin.rules['no-reverse-imports'], {
    valid: [
      {
        // Unresolvable, therefore skipped — not silently legal. The distinction
        // matters: if `features` ever came back in the table by accident, this
        // would start reporting and the fixtures above would fail.
        code: "import { x } from '@/features/anything';",
        filename: '/p/web/src/components/ui/probe.tsx',
      },
    ],
    invalid: [
      {
        // The same edge, spelled at its real home, is still enforced: a generic
        // primitive may not know what a Session is (#782).
        code: "import { SessionItem } from '@/product/session/patterns/SessionItem';",
        filename: '/p/web/src/components/ui/probe.tsx',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        // And `shared` is still below `product`.
        code: "import { sessionsApi } from '@/product/session';",
        filename: '/p/web/src/lib/thing.ts',
        errors: [{ messageId: 'reverseImport' }],
      },
    ],
  });
});

// The new layer, and its two edges. `platform` is machinery: it may reach
// `shared` and be reached by everything above it, and it may not reach up.
test('platform sits above shared and below everything that means something', () => {
  ruleTester.run('no-reverse-imports', nessionPlugin.rules['no-reverse-imports'], {
    valid: [
      // capabilities compose it — the Files capability renders the Explorer.
      {
        code: "import { Explorer } from '@/platform/explorer/components/Explorer';",
        filename: '/p/web/src/capabilities/files/components/FileBrowser.tsx',
      },
      // app composes it directly too.
      {
        code: "import { serverApi } from '@/platform/server';",
        filename: '/p/web/src/app/useAppConnection.ts',
      },
      // and it composes shared.
      {
        code: "import { cn } from '@/lib/utils';",
        filename: '/p/web/src/platform/explorer/components/Explorer.tsx',
      },
    ],
    invalid: [
      {
        // platform may not reach up into a capability.
        code: "import { createFilesApi } from '@/capabilities/files';",
        filename: '/p/web/src/platform/explorer/components/Explorer.tsx',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        // nor into the product.
        code: "import { TerminalSurface } from '@/product/terminal/TerminalSurface';",
        filename: '/p/web/src/platform/explorer/components/Explorer.tsx',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        // and nothing below it may reach it — `shared` is the floor.
        code: "import { Explorer } from '@/platform/explorer/components/Explorer';",
        filename: '/p/web/src/lib/thing.ts',
        errors: [{ messageId: 'reverseImport' }],
      },
    ],
  });
});

// Modules directly under `src/` are on real edges, and a directory-shaped lookup
// returns `unknown` for them — so both spellings of an edge to them were
// unchecked. `types.ts` is `shared` (every layer may reach it); `App.tsx` is the
// composition root (nothing below app may).
test('files directly under src/ are classified rather than skipped', () => {
  ruleTester.run('no-reverse-imports', nessionPlugin.rules['no-reverse-imports'], {
    valid: [
      { code: "import { Session } from '@/types';", filename: '/p/web/src/lib/thing.ts' },
      { code: "import { Session } from '../types';", filename: '/p/web/src/lib/thing.ts' },
      { code: "import { App } from '@/App';", filename: '/p/web/src/app/mainThing.ts' },
    ],
    invalid: [
      {
        code: "import { App } from '@/App';",
        filename: '/p/web/src/lib/thing.ts',
        errors: [{ messageId: 'reverseImport' }],
      },
      {
        code: "import { App } from '../App';",
        filename: '/p/web/src/services/thing.ts',
        errors: [{ messageId: 'reverseImport' }],
      },
    ],
  });
});

// #793. The rule resolves a directory to a layer through a table, and anything
// absent from it becomes `unknown` — which `checkRuntimeEdge` skips. An
// unmapped directory is therefore indistinguishable from a legal one, in both
// directions, while looking perfectly covered. `markdown/` and `extensions/`
// sat in that bucket.
//
// This is the assertion that makes the table's completeness a checked property
// of the repo rather than something the next person has to remember.
test('every src/ directory is classified — mapped, or deliberately not a layer', () => {
  const srcDir = fileURLToPath(new URL('../../src', import.meta.url));
  const dirs = readdirSync(srcDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const unclassified = dirs.filter(
    (dir) => !(dir in LEGACY_TO_LAYER) && !(dir in NON_LAYER_DIRS),
  );
  assert.deepEqual(
    unclassified,
    [],
    `src/ ${unclassified.join(', ')} has no layer. Add it to LEGACY_TO_LAYER `
      + '(plus ALLOWED_IMPORTS if it is a new layer), or to NON_LAYER_DIRS with a '
      + 'reason. Leaving it out means every edge touching it is silently skipped '
      + 'while appearing covered — that is #793.',
  );

  // The other direction: an exemption for a directory that no longer exists is
  // stale documentation pretending to be a decision.
  const stale = Object.keys(NON_LAYER_DIRS).filter((dir) => !dirs.includes(dir));
  assert.deepEqual(
    stale,
    [],
    `NON_LAYER_DIRS names directories that do not exist: ${stale.join(', ')}`,
  );

  // Modules directly under `src/` sit on real edges — `types.ts` is imported by
  // every layer — but the directory-shaped lookup above cannot see them, so they
  // resolved to `unknown` and went unchecked in both directions. Same hole as
  // `markdown/`, one level up (#793's general form, closed for files here).
  // Keyed the way an import specifier would spell them, so `.d.ts` drops both
  // extensions.
  const rootFiles = readdirSync(srcDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => entry.name.replace(/\.d\.ts$/, '').replace(/\.tsx?$/, ''));

  const unclassifiedRoots = rootFiles.filter((file) => !(file in ROOT_FILE_LAYER));
  assert.deepEqual(
    unclassifiedRoots,
    [],
    `src/ ${unclassifiedRoots.join(', ')} has no layer. Add it to ROOT_FILE_LAYER. `
      + 'A root module outside the table resolves to `unknown`, and every edge '
      + 'touching it is silently skipped while appearing covered.',
  );

  const staleRoots = Object.keys(ROOT_FILE_LAYER).filter((f) => !rootFiles.includes(f));
  assert.deepEqual(
    staleRoots,
    [],
    `ROOT_FILE_LAYER names modules that do not exist: ${staleRoots.join(', ')}`,
  );
});
