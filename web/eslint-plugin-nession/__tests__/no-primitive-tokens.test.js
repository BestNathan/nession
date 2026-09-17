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

// A generated shadcn primitive is not exempt from the design system just
// because the CLI wrote it (#759 SC7). The rule has no filename filter, so the
// only thing that can make it skip `components/ui/` is a regression in the
// rule — which is what these fixtures pin.
const UI_PRIMITIVE = '/proj/web/src/components/ui/probe.tsx';

test('findPrimitiveInString flags green-500 with suggestions', () => {
  const hit = findPrimitiveInString('text-green-500', lintMetadata);
  assert.ok(hit);
  assert.match(hit.message, /agent-online/);
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
  valid: [{ code: 'export const x = "text-agent-online"' }],
  invalid: [
    {
      code: 'export const x = "touch-target-min"',
      errors: [{ message: /App experience class "touch-target-min"/ }],
    },
  ],
});

// #759 SC7 — a shadcn primitive that brings an upstream raw visual decision into
// the product must fail on the parts that are mechanically decidable: the
// palette, and literal colors in class strings or inline styles.
test('a new shadcn primitive with raw visual decisions fails the gate', () => {
  ruleTester.run('no-primitive-tokens', nessionPlugin.rules['no-primitive-tokens'], {
    valid: [
      {
        code: 'export const x = "bg-background text-foreground border-input";',
        filename: UI_PRIMITIVE,
      },
    ],
    invalid: [
      {
        // Upstream palette re-entering the product.
        code: 'export function Probe() { return <div className="text-green-500" />; }',
        filename: UI_PRIMITIVE,
        errors: [{ message: /Primitive color "green-500"/ }],
      },
      {
        // An arbitrary literal color in a class string.
        code: 'export function Probe() { return <div className="bg-[#f6f8fa]" />; }',
        filename: UI_PRIMITIVE,
        errors: [{ message: /Literal color/ }],
      },
      {
        // A literal color smuggled through an inline style object.
        code: 'export function Probe() { return <div style={{ color: "#008450" }} />; }',
        filename: UI_PRIMITIVE,
        errors: [{ message: /Literal color/ }],
      },
    ],
  });
});
