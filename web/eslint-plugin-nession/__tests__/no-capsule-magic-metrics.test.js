import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import nessionPlugin from '../index.js';

// The capsule moved from `src/session-first/capsule/` to
// `src/features/terminal/capsule/`. These fixtures kept the old path, so every
// `invalid` case asserted errors the rule could not produce (it returns {} for
// a filename outside CAPSULE_GLOB) and the allowlist test read a file that no
// longer existed. Nothing caught it because no gate ran this file at all
// (issue #759). Fixtures are now written against the live path, and
// `just design-check` runs them, so the next move breaks the gate loudly
// instead of silently.
const CAPSULE = '/proj/web/src/features/terminal/capsule/';

const ruleTester = new RuleTester({
  parser: tseslint.parser,
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
});

test('no-capsule-magic-metrics flags tailwind numeric classes in capsule path', () => {
  ruleTester.run('no-capsule-magic-metrics', nessionPlugin.rules['no-capsule-magic-metrics'], {
    valid: [
      {
        code: 'export function Ok() { return <div className="text-[length:var(--composer-font-size)]" />; }',
        filename: `${CAPSULE}Ok.tsx`,
      },
      {
        code: 'export const x = "h-8 text-xs";',
        filename: `${CAPSULE}capsuleStyles.ts`,
      },
    ],
    invalid: [
      {
        code: 'export function Probe() { return <div className="h-8 text-xs" />; }',
        filename: `${CAPSULE}Probe.tsx`,
        errors: [{ messageId: 'violation' }, { messageId: 'violation' }],
      },
      {
        code: 'export function Probe() { return <PopoverContent sideOffset={8} />; }',
        filename: `${CAPSULE}Probe.tsx`,
        errors: [{ messageId: 'sideOffset' }],
      },
    ],
  });
});

// The fault fixture for arbitrary design metrics (#759 SC5). Each of these is a
// feature-local magic number that a screenshot would not distinguish from the
// token it should have used, so the gate has to fail on the source.
test('no-capsule-magic-metrics fails on arbitrary design metrics', () => {
  ruleTester.run('no-capsule-magic-metrics', nessionPlugin.rules['no-capsule-magic-metrics'], {
    valid: [],
    invalid: [
      {
        // h-[34px]: an arbitrary height that bypasses the control band.
        // Caught twice on purpose — the metric scale sees `h-[3` and the
        // numeric-arbitrary branch sees `[34px]`.
        code: 'export function Probe() { return <div className="h-[34px]" />; }',
        filename: `${CAPSULE}Probe.tsx`,
        errors: [{ messageId: 'violation' }, { messageId: 'violation' }],
      },
      {
        // rounded-[7px]: geometry that belongs to a radius token. Only the
        // numeric-arbitrary branch sees it — `rounded` is not a metric prefix.
        code: 'export function Probe() { return <div className="rounded-[7px]" />; }',
        filename: `${CAPSULE}Probe.tsx`,
        errors: [{ messageId: 'violation' }],
      },
      {
        // py-[7px]: spacing that belongs to a spacing token.
        code: 'export function Probe() { return <div className="py-[7px]" />; }',
        filename: `${CAPSULE}Probe.tsx`,
        errors: [{ messageId: 'violation' }, { messageId: 'violation' }],
      },
      {
        // text-[13px]: the text scale and the numeric-arbitrary branch both fire.
        code: 'export function Probe() { return <div className="text-[13px]" />; }',
        filename: `${CAPSULE}Probe.tsx`,
        errors: [{ messageId: 'violation' }, { messageId: 'violation' }],
      },
    ],
  });
});

test('capsuleStyles allowlist stays exempt', () => {
  const stylesPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../src/features/terminal/capsule/capsuleStyles.ts',
  );
  const source = readFileSync(stylesPath, 'utf8');
  assert.doesNotMatch(source, /\bh-8\b|\btext-xs\b/);
});
