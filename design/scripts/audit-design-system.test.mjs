import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkInventory,
  classifyZeroConsumer,
  extractLayoutSignatures,
  normalizeRef,
} from './audit-design-system.mjs';

test('normalizeRef collapses semantic themes and expands theme placeholders', () => {
  assert.deepEqual(normalizeRef('semantic.themes.light.background'), ['semantic.background']);
  assert.deepEqual(normalizeRef('semantic.background'), ['semantic.background']);
  assert.deepEqual(normalizeRef('primitive.{theme}.location.local'), [
    'primitive.light.location.local',
    'primitive.dark.location.local',
  ]);
});

test('layout signatures keep structural relationships and ignore visual classes', () => {
  const signatures = extractLayoutSignatures(`
    <div className="flex items-center gap-2 rounded-md bg-background px-2" />
    <div className={\`flex flex-col gap-3 text-sm\`} />
  `);
  assert.deepEqual(signatures, [
    'flex gap-2 items-center',
    'flex flex-col gap-3',
  ]);
});

test('zero-consumer classification makes absence explicit by layer', () => {
  assert.equal(
    classifyZeroConsumer({ id: 'primitive.light.neutral.ground', layer: 'primitive', effectiveConsumers: [] }).status,
    'intentional',
  );
  assert.equal(
    classifyZeroConsumer({ id: 'semantic.chart-1', layer: 'semantic', effectiveConsumers: [] }).status,
    'reserved',
  );
  assert.equal(
    classifyZeroConsumer({ id: 'domain.workspace.navigation', layer: 'domain', effectiveConsumers: [] }).status,
    'reserved',
  );
});

test('checkInventory rejects dangling token references', () => {
  const errors = checkInventory({
    tokens: {
      missingRefs: [{ from: 'domain.a', ref: 'semantic.missing' }],
      records: [],
    },
    components: [{}],
  });
  assert.deepEqual(errors, ['missing token ref: domain.a -> semantic.missing']);
});
