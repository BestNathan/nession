import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import nessionPlugin from '../index.js';

// #801 acceptance criterion: "capability cross-import 通过明确 public API/
// contract，而不是任意 deep import". 13 such imports existed when this rule was
// written (app/experiences/*, product/session/components/*,
// product/terminal/capsule/*); all now go through the capability index. These
// fixtures are what make the rule's silence on the real tree meaningful.
const APP = '/p/web/src/app/experiences/web/FilesWebLayout.tsx';
const PRODUCT = '/p/web/src/product/session/components/AttachDialog.tsx';

const ruleTester = new RuleTester({
  parser: tseslint.parser,
  parserOptions: { ecmaVersion: 2020, sourceType: 'module', ecmaFeatures: { jsx: true } },
});

test('no-deep-capability-imports keeps cross-imports on the public API', () => {
  ruleTester.run('no-deep-capability-imports', nessionPlugin.rules['no-deep-capability-imports'], {
    valid: [
      // The capability root IS the public API — this is the form the rule wants.
      { code: "import { FileViewer } from '@/capabilities/files';", filename: APP },
      { code: "import { EnvFileMultiSelect, envApi } from '@/capabilities/env';", filename: PRODUCT },
      // The same root, spelled relatively.
      { code: "import { x } from '../../capabilities/files';", filename: APP },
      // A capability's own internals are its own business.
      {
        code: "import { sourceLabel } from '@/capabilities/env/model/envRef';",
        filename: '/p/web/src/capabilities/env/components/EnvManager.tsx',
      },
      {
        code: "import { EnvDiff } from './EnvDiff';",
        filename: '/p/web/src/capabilities/env/components/EnvInlineEditor.tsx',
      },
      // Test files are exempt, exactly as `no-reverse-imports` has it: a test
      // wiring a capability's internals to assert on them is doing its job.
      {
        code: "import { useQuickCommands } from '@/capabilities/commands/hooks/useQuickCommands';",
        filename: '/p/web/src/product/terminal/capsule/__tests__/unit/useCapsuleCommands.test.ts',
      },
      // Not this rule's business.
      { code: "import * as React from 'react';", filename: APP },
      { code: "import { cn } from '@/shared/lib/utils';", filename: APP },
      { code: "import { x } from '../../product/terminal/pane';", filename: APP },
    ],
    invalid: [
      {
        // The exact shape that was shipping from app/experiences/web.
        code: "import { FileViewer } from '@/capabilities/files/components/FileViewer';",
        filename: APP,
        errors: [{ messageId: 'violation' }],
      },
      {
        // …and from product/. The rule is not app-specific.
        code: "import { EnvFileMultiSelect } from '@/capabilities/env/components/EnvFileMultiSelect';",
        filename: PRODUCT,
        errors: [{ messageId: 'violation' }],
      },
      {
        code: "import { useQuickCommands } from '@/capabilities/commands/hooks/useQuickCommands';",
        filename: '/p/web/src/product/terminal/capsule/useCapsuleCommands.ts',
        errors: [{ messageId: 'violation' }],
      },
      {
        // A re-export is the same edge as an import (#788/#791's taxonomy).
        code: "export { EnvManager } from '@/capabilities/env/components/EnvManager';",
        filename: APP,
        errors: [{ messageId: 'violation' }],
      },
      {
        // The relative spelling of the same edge. Covering only the alias
        // would leave the identical hole with a different spelling — the trap
        // `no-reverse-imports` records.
        code: "import { FileList } from '../../../capabilities/files/components/FileList';",
        filename: '/p/web/src/app/experiences/web/deep/Layout.tsx',
        errors: [{ messageId: 'violation' }],
      },
    ],
  });
});

// A **type** deep-import is in scope here, unlike in `no-reverse-imports`.
// That rule polices runtime edges, so an erased import is none of its business.
// This one polices a capability's public surface, and a type is part of that
// surface: if `app/` reads `FileEntry` from `@/capabilities/files/types`, the
// capability cannot move or split `types.ts`. It is not hypothetical — 2 of the
// 13 imports this rule was written for were exactly that shape, in the root
// `types.ts` barrel.
//
// Driven through the visitor directly: `import type` does not parse in the
// legacy RuleTester config, the same reason `no-reverse-imports` drives its
// type cases by hand.
test('a type-only deep import is still a deep import', () => {
  const rule = nessionPlugin.rules['no-deep-capability-imports'];
  const reportFor = (value) => {
    const reported = [];
    const visitors = rule.create({
      filename: '/p/web/src/app/experiences/web/FilesWebLayout.tsx',
      report: (d) => reported.push(d),
    });
    visitors.ImportDeclaration({ source: { type: 'Literal', value } });
    return reported;
  };

  assert.equal(
    reportFor('@/capabilities/files/components/FileViewer').length,
    1,
    'a type-only deep import must report — the capability cannot move the file either way',
  );
  assert.equal(
    reportFor('@/capabilities/files').length,
    0,
    'the capability root stays the allowed form for types too',
  );
});

// A rule that exists but is not enabled protects nothing while reading as
// coverage — the same failure class this rule is about. If someone adds the
// rule file and forgets either wiring step, this fails rather than going quiet.
test('the rule is registered in the plugin and enabled as an error', () => {
  assert.ok(
    nessionPlugin.rules['no-deep-capability-imports'],
    'the rule must be exported from eslint-plugin-nession/index.js',
  );
  const here = fileURLToPath(new URL('.', import.meta.url));
  const config = readFileSync(new URL('../../eslint.config.js', `file://${here}`), 'utf8');
  assert.match(
    config,
    /'nession\/no-deep-capability-imports':\s*'error'/,
    "eslint.config.js must enable it — otherwise the rule is inert on the real tree",
  );
});
