import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { findPrimitiveInString } from '../rules/no-primitive-tokens.js';
import { findAppExperienceClass } from '../rules/no-cross-experience-token.js';
import nessionPlugin from '../index.js';

const metadataPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../design/generated/lint-metadata.json',
);
const lintMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));

test('findPrimitiveInString flags green-500 with suggestions', () => {
  const hit = findPrimitiveInString('text-green-500', lintMetadata);
  assert.ok(hit);
  assert.match(hit.message, /success/);
});

test('findPrimitiveInString allows semantic tokens', () => {
  assert.equal(findPrimitiveInString('text-agent-online', lintMetadata), null);
  assert.equal(findPrimitiveInString('bg-background', lintMetadata), null);
});

test('findPrimitiveInString flags arbitrary colors', () => {
  const hit = findPrimitiveInString('bg-[#fff]', lintMetadata);
  assert.ok(hit);
  assert.equal(hit.primitiveId, 'literal');
});

test('findAppExperienceClass flags touch-target-min', () => {
  assert.equal(findAppExperienceClass('touch-target-min', lintMetadata), 'touch-target-min');
});

const ruleTester = new RuleTester({
  parser: tseslint.parser,
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
});

ruleTester.run('no-primitive-tokens', nessionPlugin.rules['no-primitive-tokens'], {
  valid: [{ code: 'export const x = "text-agent-online"' }],
  invalid: [
    {
      code: 'export const x = "text-green-500"',
      errors: [{ message: /Primitive color "green-500"/ }],
    },
  ],
});

ruleTester.run('no-cross-experience-token', nessionPlugin.rules['no-cross-experience-token'], {
  valid: [{ code: 'export const x = "text-success"' }],
  invalid: [
    {
      code: 'export const x = "touch-target-min"',
      errors: [{ message: /App experience class "touch-target-min"/ }],
    },
  ],
});
