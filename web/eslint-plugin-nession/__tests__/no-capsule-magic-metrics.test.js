import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import nessionPlugin from '../index.js';

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
        code: 'export function Ok() { return <div className="text-[length:var(--terminal-capsule-font-size)]" />; }',
        filename: '/proj/web/src/product/terminal/capsule/Ok.tsx',
      },
      {
        code: 'export const x = "h-8 text-xs";',
        filename: '/proj/web/src/product/terminal/capsule/capsuleStyles.ts',
      },
    ],
    invalid: [
      {
        code: 'export function Probe() { return <div className="h-8 text-xs" />; }',
        filename: '/proj/web/src/product/terminal/capsule/Probe.tsx',
        errors: [{ messageId: 'violation' }, { messageId: 'violation' }],
      },
      {
        code: 'export function Probe() { return <PopoverContent sideOffset={8} />; }',
        filename: '/proj/web/src/product/terminal/capsule/Probe.tsx',
        errors: [{ messageId: 'sideOffset' }],
      },
      {
        // The `font-via-line-height` branch. It had **no fixture** until the
        // #801 Phase 6-style token rename, at which point the pattern pointed at
        // a name nothing emits any more — a branch that could never fire, with
        // nothing to notice. Exercised here so it cannot go quiet again.
        code: 'export function Probe() { return <div className="text-[length:var(--terminal-capsule-line-height)]" />; }',
        filename: '/proj/web/src/product/terminal/capsule/Probe.tsx',
        errors: [{ messageId: 'violation' }],
      },
    ],
  });
});

// The rule matches token names *as strings*. Renaming a token in
// `design/tokens/` therefore re-points every pattern in the rule, and a pattern
// pointing at a name nothing emits is a rule that reads as coverage while
// protecting nothing. This asserts each concrete token the rule names still
// exists in the generated CSS, so the next token rename fails loudly here
// instead of silently disarming the capsule gate.
test('every token the rule names still exists in the generated CSS', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const ruleSource = readFileSync(join(here, '../rules/no-capsule-magic-metrics.js'), 'utf8');
  const generatedCss = readFileSync(join(here, '../../../design/generated/web.css'), 'utf8');

  // `--control-*` style entries are wildcards, not names; only check concretes.
  const named = new Set(
    (ruleSource.match(/--[a-z][a-z0-9-]+/g) ?? []).filter((v) => !v.endsWith('-')),
  );
  assert.ok(named.size > 0, 'the rule must name at least one concrete token');

  const missing = [...named].filter((token) => !generatedCss.includes(`${token}:`));
  assert.deepEqual(
    missing,
    [],
    'the rule names tokens the token source no longer emits — it is silently disarmed',
  );
});

test('capsuleStyles allowlist stays exempt', () => {
  const stylesPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../src/product/terminal/capsule/capsuleStyles.ts',
  );
  const source = readFileSync(stylesPath, 'utf8');
  assert.doesNotMatch(source, /\bh-8\b|\btext-xs\b/);
});
