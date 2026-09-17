import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import nessionPlugin from '../index.js';

// #774 Workstream 3. The boundary `components.md` states, made mechanical for
// the one directory where it is unambiguous. `ConnectionStatusBadge` crossed it
// — importing `ConnectionState` from `services/socket` — and nothing objected,
// because `no-reverse-imports` cannot fire (it reads the source layer from the
// import path). These fixtures are what make this rule's silence meaningful.
const UI = '/p/web/src/components/ui/';

const ruleTester = new RuleTester({
  parser: tseslint.parser,
  parserOptions: { ecmaVersion: 2020, sourceType: 'module', ecmaFeatures: { jsx: true } },
});

test('no-ui-product-imports keeps components/ui generic', () => {
  ruleTester.run('no-ui-product-imports', nessionPlugin.rules['no-ui-product-imports'], {
    valid: [
      // Siblings inside components/ui, relative and aliased.
      { code: "import { Badge } from './badge';", filename: `${UI}probe.tsx` },
      { code: "import { cn } from '@/components/ui/utils';", filename: `${UI}probe.tsx` },
      // The shared layer is below every primitive and is allowed.
      { code: "import { cn } from '@/lib/utils';", filename: `${UI}probe.tsx` },
      { code: "import { useThing } from '@/shared/hooks/useThing';", filename: `${UI}probe.tsx` },
      // External packages are not this rule's business.
      { code: "import * as React from 'react';", filename: `${UI}probe.tsx` },
      // Going up one level stays inside components/.
      { code: "import { x } from '../types';", filename: `${UI}probe.tsx` },
      // Not a primitives file — the rule does not police the rest of the tree.
      { code: "import { ConnectionState } from '@/services/socket';", filename: '/p/web/src/app/LoginPage.tsx' },
    ],
    invalid: [
      {
        // The shape that shipped: a primitive bound to a service state machine.
        code: "import { ConnectionState } from '@/services/socket';",
        filename: `${UI}ConnectionStatusBadge.tsx`,
        errors: [{ messageId: 'violation' }],
      },
      {
        code: "import { SessionItem } from '@/features/sessions/components/SessionItem';",
        filename: `${UI}probe.tsx`,
        errors: [{ messageId: 'violation' }],
      },
      {
        code: "import { x } from '@/app/patterns/ConnectionStatus';",
        filename: `${UI}probe.tsx`,
        errors: [{ messageId: 'violation' }],
      },
      {
        code: "import { connectionAtom } from '@/atoms/connection';",
        filename: `${UI}probe.tsx`,
        errors: [{ messageId: 'violation' }],
      },
      {
        // A relative import that climbs out of components/ui entirely.
        code: "import { x } from '../../services/socket';",
        filename: `${UI}probe.tsx`,
        errors: [{ messageId: 'violation' }],
      },
    ],
  });
});

test('the violation names the import, the owner, and the repair', () => {
  const rule = nessionPlugin.rules['no-ui-product-imports'];
  const reported = [];
  const context = {
    filename: `${UI}probe.tsx`,
    report(descriptor) {
      reported.push(descriptor);
    },
  };
  rule
    .create(context)
    .ImportDeclaration({ source: { value: '@/services/socket' } });

  assert.equal(reported.length, 1);
  const message = rule.meta.messages.violation.replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => reported[0].data[key],
  );
  assert.match(message, /@\/services\/socket/);
  assert.match(message, /owner: {2}web\/src\/components\/ui\//);
  assert.match(message, /repair:/);
  assert.match(message, /nession\/no-ui-product-imports/);
});
