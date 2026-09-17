import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import nessionPlugin from '../index.js';
import {
  controlVarFromTokenId,
  findControlBandViolation,
} from '../rules/no-capsule-control-band.js';

// The fault fixture for #759 SC6: "wrong token name, coincidentally the same
// px". On App, control.sm and control.md both resolve to 44px, so the viewport
// matrix — which only measures px — cannot tell a control that composed the
// wrong band from one that composed the right one (#742).
//
// These fixtures pass or fail on the *name* alone, with no px involved, which
// is the point: the assertion has to survive the two bands diverging.

const CAPSULE = '/proj/web/src/features/terminal/capsule/';

test('controlVarFromTokenId maps a token id to the emitted custom property', () => {
  assert.equal(controlVarFromTokenId('experience.app.control.md'), 'control-md');
  assert.equal(controlVarFromTokenId('experience.web.control.md'), 'control-md');
  // camelCase segments kebab the same way emitCustomProps does.
  assert.equal(controlVarFromTokenId('experience.app.touchTarget.min'), 'touch-target-min');
  assert.equal(controlVarFromTokenId('experience.web.dockTarget'), 'dock-target');
  // Anything that is not an experience token id has no emitted custom property.
  assert.equal(controlVarFromTokenId('domain.session.state'), null);
  assert.equal(controlVarFromTokenId(undefined), null);
});

test('findControlBandViolation compares the band name, never the resolved px', () => {
  assert.equal(findControlBandViolation('h-[length:var(--control-md)]', ['control-md']), null);
  assert.deepEqual(findControlBandViolation('h-[length:var(--control-sm)]', ['control-md']), {
    found: 'control-sm',
    expected: 'control-md',
  });
  assert.deepEqual(findControlBandViolation('min-h-[length:var(--control-lg)]', ['control-md']), {
    found: 'control-lg',
    expected: 'control-md',
  });
  // Width is a different axis: a narrower keycap is not a height-band violation.
  assert.equal(findControlBandViolation('min-w-[length:var(--control-sm)]', ['control-md']), null);
});

const ruleTester = new RuleTester({
  parser: tseslint.parser,
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
});

test('no-capsule-control-band fails a wrong band even when the px is identical', () => {
  const rule = nessionPlugin.rules['no-capsule-control-band'];
  assert.ok(rule, 'rule not registered in the plugin — index.js must expose it');

  ruleTester.run('no-capsule-control-band', rule, {
    valid: [
      {
        code: 'export const ok = "h-[length:var(--control-md)]";',
        filename: `${CAPSULE}capsuleStyles.ts`,
      },
      {
        code: 'export const keycap = "min-w-[length:var(--control-sm)]";',
        filename: `${CAPSULE}capsuleStyles.ts`,
      },
      {
        // The band rule is capsule-scoped; the same string elsewhere is not its business.
        code: 'export const other = "h-[length:var(--control-sm)]";',
        filename: '/proj/web/src/app/SessionFirstShell.tsx',
      },
    ],
    invalid: [
      {
        code: 'export const bad = "h-[length:var(--control-sm)]";',
        filename: `${CAPSULE}capsuleStyles.ts`,
        errors: [{ messageId: 'band' }],
      },
      {
        code: 'export function Probe() { return <button className="min-h-[length:var(--control-sm)] w-full" />; }',
        filename: `${CAPSULE}components/Probe.tsx`,
        errors: [{ messageId: 'band' }],
      },
    ],
  });
});

test('the violation names the contract, the found band, and the repair', () => {
  const rule = nessionPlugin.rules['no-capsule-control-band'];
  const reported = [];
  const context = {
    filename: `${CAPSULE}capsuleStyles.ts`,
    report(descriptor) {
      reported.push(descriptor);
    },
  };
  const visitors = rule.create(context);
  visitors.Literal({ type: 'Literal', value: 'h-[length:var(--control-sm)]' });

  assert.equal(reported.length, 1);
  const message = rule.meta.messages.band.replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => reported[0].data[key],
  );
  // SC8: file/pattern, rule, actual, expected owner and repair direction.
  assert.match(message, /var\(--control-sm\)/);
  assert.match(message, /pattern\.terminal-capsule/);
  assert.match(message, /experience\.app\.control\.md/);
  assert.match(message, /owner: {2}design\/contracts\/patterns\/terminal-capsule\.json/);
  assert.match(message, /repair:/);
  assert.match(message, /nession\/no-capsule-control-band/);
});
