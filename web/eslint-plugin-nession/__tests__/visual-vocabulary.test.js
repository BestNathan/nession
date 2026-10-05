import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import nessionPlugin from '../index.js';
import {
  findVisualUtilityViolations,
  findVisualVariableViolations,
} from '../rules/visual-vocabulary.js';

const metadataPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../design/generated/lint-metadata.json',
);
const lintMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));

const PRODUCT = '/proj/web/src/product/session/components/Probe.tsx';
const EDITOR_ADAPTER = '/proj/web/src/platform/editor/model/editorTheme.ts';

test('generated metadata makes the --nession-* namespace machine-readable', () => {
  assert.ok(lintMetadata.cssVariables.includes('--nession-background'));
  assert.ok(lintMetadata.cssVariables.includes('--nession-radius-control'));
  assert.ok(lintMetadata.legacyCssVariables.includes('--background'));
  assert.equal(
    lintMetadata.tailwindThemeBridges.color.background,
    '--nession-background',
  );
});

test('visual utility classifier separates local composition from visual vocabulary', () => {
  for (const allowed of [
    'flex items-center justify-between overflow-auto relative',
    'bg-background text-muted-foreground border-border',
    'rounded-[var(--nession-radius-control)]',
    'shadow-[var(--nession-elevation-floating)]',
  ]) {
    assert.deepEqual(
      findVisualUtilityViolations(allowed, lintMetadata),
      [],
      `expected canonical/local composition to remain legal: ${allowed}`,
    );
  }

  const violations = findVisualUtilityViolations(
    'text-sm font-semibold rounded-lg bg-white shadow-md text-[13px]',
    lintMetadata,
  );
  assert.deepEqual(
    violations.map((v) => [v.token, v.kind]),
    [
      ['text-sm', 'typography'],
      ['font-semibold', 'typography'],
      ['rounded-lg', 'radius'],
      ['bg-white', 'color'],
      ['shadow-md', 'elevation'],
      ['text-[13px]', 'typography'],
    ],
  );
});

test('findVisualVariableViolations accepts generated and local Nession variables', () => {
  assert.deepEqual(
    findVisualVariableViolations(
      'bg-[var(--nession-background)] rounded-[var(--nession-radius-control)]',
      lintMetadata,
      PRODUCT,
    ),
    [],
  );
  assert.deepEqual(
    findVisualVariableViolations('w-[var(--nession-local-probe-width)]', lintMetadata, PRODUCT),
    [],
  );
});

test('findVisualVariableViolations rejects legacy, unknown and foreign vocabulary', () => {
  assert.deepEqual(
    findVisualVariableViolations('var(--background)', lintMetadata, PRODUCT),
    [{ name: 'background', kind: 'legacy', repair: 'var(--nession-background)' }],
  );
  assert.equal(
    findVisualVariableViolations('var(--nession-invented-token)', lintMetadata, PRODUCT)[0]?.kind,
    'unknown-nession',
  );
  assert.equal(
    findVisualVariableViolations('var(--some-library-color)', lintMetadata, PRODUCT)[0]?.kind,
    'foreign',
  );
});

test('approved renderer adapters may consume foreign variables but not legacy Nession aliases', () => {
  assert.deepEqual(
    findVisualVariableViolations('var(--cm-editor-background)', lintMetadata, EDITOR_ADAPTER),
    [],
  );
  assert.equal(
    findVisualVariableViolations('var(--background)', lintMetadata, EDITOR_ADAPTER)[0]?.kind,
    'legacy',
  );
});

const ruleTester = new RuleTester({
  parser: tseslint.parser,
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
});

test('visual-vocabulary reports non-canonical production variables', () => {
  ruleTester.run('visual-vocabulary', nessionPlugin.rules['visual-vocabulary'], {
    valid: [
      {
        code: 'export const x = "bg-[var(--nession-background)]";',
        filename: PRODUCT,
      },
      {
        code: 'export const x = "color: var(--cm-editor-background)";',
        filename: EDITOR_ADAPTER,
      },
    ],
    invalid: [
      {
        code: 'export const x = "bg-[var(--background)]";',
        filename: PRODUCT,
        errors: [{ messageId: 'violation' }],
      },
      {
        code: 'export const x = "bg-[var(--nession-made-up)]";',
        filename: PRODUCT,
        errors: [{ messageId: 'violation' }],
      },
      {
        code: 'export const x = "color: var(--foreign-theme)";',
        filename: PRODUCT,
        errors: [{ messageId: 'violation' }],
      },
    ],
  });
});

test('violation output gives the canonical repair path', () => {
  const rule = nessionPlugin.rules['visual-vocabulary'];
  const reported = [];
  const context = {
    filename: PRODUCT,
    report(descriptor) {
      reported.push(descriptor);
    },
  };
  rule.create(context).Literal({ type: 'Literal', value: 'var(--background)' });

  assert.equal(reported.length, 1);
  const message = rule.meta.messages.violation.replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => reported[0].data[key],
  );
  assert.match(message, /DESIGN_SYSTEM_VIOLATION/);
  assert.match(message, /nession\/visual-vocabulary/);
  assert.match(message, /var\(--background\)/);
  assert.match(message, /var\(--nession-background\)/);
  assert.match(message, /design\/tokens/);
});
