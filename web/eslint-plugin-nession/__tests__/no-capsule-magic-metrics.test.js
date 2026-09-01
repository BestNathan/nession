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
        code: 'export function Ok() { return <div className="text-[length:var(--composer-font-size)]" />; }',
        filename: '/proj/web/src/session-first/capsule/Ok.tsx',
      },
      {
        code: 'export const x = "h-8 text-xs";',
        filename: '/proj/web/src/session-first/capsule/capsuleStyles.ts',
      },
    ],
    invalid: [
      {
        code: 'export function Probe() { return <div className="h-8 text-xs" />; }',
        filename: '/proj/web/src/session-first/capsule/Probe.tsx',
        errors: [{ messageId: 'violation' }, { messageId: 'violation' }],
      },
      {
        code: 'export function Probe() { return <PopoverContent sideOffset={8} />; }',
        filename: '/proj/web/src/session-first/capsule/Probe.tsx',
        errors: [{ messageId: 'sideOffset' }],
      },
    ],
  });
});

test('capsuleStyles allowlist stays exempt', () => {
  const stylesPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../src/session-first/capsule/capsuleStyles.ts',
  );
  const source = readFileSync(stylesPath, 'utf8');
  assert.doesNotMatch(source, /\bh-8\b|\btext-xs\b/);
});
