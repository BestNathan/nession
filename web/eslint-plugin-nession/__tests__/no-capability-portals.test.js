import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import nessionPlugin from '../index.js';

// The negative escape test #1347 SC-27 asks for: the re-review held the
// criterion at Fail because `contain: paint` cannot constrain a React portal,
// and the previous evidence — "no capability body uses portal" — proved only
// that today's bodies happen to obey the convention, never that a plugin
// *cannot* escape. Each `invalid` case below is an escape attempt, and the
// rule rejecting it is the enforceable half. The `valid` cases are the ones
// that keep the gate honest: the same statement outside capability code, and
// the approved host-owned overlay, must not be reported.
const CAP = '/p/web/src/capabilities/claude-code/components/ClaudeCodePeek.tsx';
const CAP_TEST =
  '/p/web/src/capabilities/claude-code/components/__tests__/integration/ClaudeCodeProjection.test.tsx';
const APP = '/p/web/src/app/experiences/app/AppPopupPortal.tsx';

const ruleTester = new RuleTester({
  parser: tseslint.parser,
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
});

test('no-capability-portals rejects static and dynamic portal escapes', () => {
  ruleTester.run('no-capability-portals', nessionPlugin.rules['no-capability-portals'], {
    valid: [
      // The approved form: the body hands the host content and the host owns
      // the overlay (#1120).
      {
        code: 'export const open = (actions) => actions.openDetail({ title: "t", content: null });',
        filename: CAP,
      },
      // react-dom for something that is not a portal is not this rule's
      // business — the gate is the escape, not the package.
      { code: "import { flushSync } from 'react-dom';", filename: CAP },
      // A capability test may mount a portal: proving what the host does with
      // one is a legitimate assertion.
      { code: "import { createPortal } from 'react-dom';", filename: CAP_TEST },
      // The app layer owns the surface and may portal (AppPopupPortal does).
      { code: "import { createPortal } from 'react-dom';", filename: APP },
    ],
    invalid: [
      {
        code: "import { createPortal } from 'react-dom';",
        filename: CAP,
        errors: [{ messageId: 'violation' }],
      },
      {
        // An alias is the same import — the rule follows the name, not the
        // spelling.
        code: "import { createPortal as cp } from 'react-dom';\nexport const x = cp;",
        filename: CAP,
        errors: [{ messageId: 'violation' }],
      },
      {
        code: "import * as ReactDOM from 'react-dom';\nexport const x = () => ReactDOM.createPortal(null, document.body);",
        filename: CAP,
        errors: [{ messageId: 'violation' }],
      },
      {
        code: "import ReactDOM from 'react-dom';\nexport const x = () => ReactDOM.createPortal(null, document.body);",
        filename: CAP,
        errors: [{ messageId: 'violation' }],
      },
      {
        // A re-export upstream is laundering, not permission: the name is the
        // escape wherever it comes from.
        code: "import { createPortal } from '@/lib/portal';",
        filename: CAP,
        errors: [{ messageId: 'violation' }],
      },
      {
        code: "export async function x() { const { createPortal } = await import('react-dom'); return createPortal; }",
        filename: CAP,
        errors: [{ messageId: 'violation' }],
      },
      {
        code: "export async function x() { return (await import('react-dom')).createPortal; }",
        filename: CAP,
        errors: [{ messageId: 'violation' }],
      },
    ],
  });
});

// A rule that exists but is not enabled protects nothing while reading as
// coverage. If someone adds the rule file and forgets either wiring step,
// this fails rather than going quiet.
test('the rule is registered in the plugin and enabled as an error', () => {
  assert.ok(
    nessionPlugin.rules['no-capability-portals'],
    'the rule must be exported from eslint-plugin-nession/index.js',
  );
  const here = fileURLToPath(new URL('.', import.meta.url));
  const config = readFileSync(new URL('../../eslint.config.js', `file://${here}`), 'utf8');
  assert.match(
    config,
    /'nession\/no-capability-portals':\s*'error'/,
    'eslint.config.js must enable it — otherwise the rule is inert on the real tree',
  );
});
