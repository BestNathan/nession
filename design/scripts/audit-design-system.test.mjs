import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildInventory,
  checkInventory,
  checkOwnership,
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

// A pattern-specific metric explains itself through `$owner`. An owner that
// resolves to nothing is worse than no owner at all — it reads as a decision
// while being a typo — so it has to fail rather than sit in the source quietly.
test('checkOwnership accepts only owners that name a real pattern doc', () => {
  const inventory = (owner) => ({
    scope: { patternDocs: ['pattern.session-item', 'pattern.terminal-capsule'] },
    tokens: { records: [{ id: 'experience.web.composer.tabHeight', owner }] },
  });

  assert.deepEqual(checkOwnership(inventory('pattern.terminal-capsule')), []);
  // Absent owner is the generic-platform default, not an error.
  assert.deepEqual(checkOwnership(inventory(null)), []);

  const [problem] = checkOwnership(inventory('pattern.workspace-tree'));
  assert.match(problem, /unknown token owner/);
  assert.match(problem, /experience\.web\.composer\.tabHeight/);
  assert.match(problem, /pattern\.workspace-tree/);
  assert.match(problem, /patterns\/\*\.md/);
});

test('the pattern doc list is read from the docs tree, not hand-kept', () => {
  const docs = buildInventory().scope.patternDocs;
  assert.ok(docs.length > 0);
  // Reading the tree is what makes "add a pattern doc" the way to legalise an owner.
  for (const name of docs) assert.match(name, /^pattern\.[a-z0-9-]+$/);
  assert.ok(docs.includes('pattern.terminal-capsule'));
});

test('$owner inherits down its group, and absent means generic platform', () => {
  const byId = new Map(buildInventory().tokens.records.map((r) => [r.id, r]));
  // Group annotation reaches every leaf under it.
  assert.equal(byId.get('experience.web.composer.tabHeight').owner, 'pattern.terminal-capsule');
  assert.equal(byId.get('experience.app.composer.physKeyPadY').owner, 'pattern.terminal-capsule');
  assert.equal(byId.get('experience.web.workspace.editorFontSize').owner, 'pattern.file-workspace');
  // Leaf annotation inside an unowned family.
  assert.equal(byId.get('experience.web.shell.sessionRowPadY').owner, 'pattern.session-item');
  // A sibling in the same family that is shared across surfaces stays unowned.
  assert.equal(byId.get('experience.web.shell.sessionRowRadius').owner, null);
  // Generic platform vocabulary.
  assert.equal(byId.get('experience.web.control.md').owner, null);
});
