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
    tokens: { records: [{ id: 'experience.web.terminalCapsule.tabHeight', owner }] },
  });

  assert.deepEqual(checkOwnership(inventory('pattern.terminal-capsule')), []);
  // Absent owner is the generic-platform default, not an error.
  assert.deepEqual(checkOwnership(inventory(null)), []);

  const [problem] = checkOwnership(inventory('pattern.workspace-tree'));
  assert.match(problem, /unknown token owner/);
  assert.match(problem, /experience\.web\.terminalCapsule\.tabHeight/);
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

// #774 Workstream 2: a typography role is only real if production text uses it.
// The failure mode this guards against is the one the requirement names —
// adding semantic roles that nothing consumes, so the vocabulary grows while
// the fragmentation it was meant to fix stays exactly where it was.
test('every typography role is reached by a production consumer', () => {
  const records = new Map(buildInventory().tokens.records.map((r) => [r.id, r]));
  const roles = ['primary', 'secondary', 'metadata', 'code'];

  for (const role of roles) {
    const id = `experience.web.typography.${role}.size`;
    const record = records.get(id);
    assert.ok(record, `${id} is missing from the token source`);
    assert.ok(
      record.downstream.length > 0,
      `${id} is not referenced by any component token — a role nothing derives from`,
    );
    assert.ok(
      record.effectiveConsumers.length > 0,
      `${id} reaches no production file — a zero-consumer role`,
    );
  }
});

test('typography roles own size only — family, weight and line-height stay out', () => {
  const ids = buildInventory().tokens.records.map((r) => r.id);
  const roleIds = ids.filter((id) => id.startsWith('experience.web.typography.'));

  assert.ok(roleIds.length > 0);
  // Every role leaf is a `.size`. Family (mono/sans) and weight are cross-cutting
  // — `font-medium` appears under every role and mono is used for both metadata
  // and primary — so folding them into a role would be wrong. Line-height belongs
  // to the block that owns it, e.g. `workspace.treeLineHeight`.
  for (const id of roleIds) {
    assert.match(id, /^experience\.web\.typography\.[a-z]+\.size$/, `${id} is not a size leaf`);
  }
});

test('one role can own a size for two different components', () => {
  const records = new Map(buildInventory().tokens.records.map((r) => [r.id, r]));
  const role = records.get('experience.web.typography.secondary.size');
  // A section heading and a tree row are different components with the same
  // text job. Before this, each stated 11px independently.
  assert.deepEqual(role.downstream.slice().sort(), [
    'experience.web.shell.sectionHeadFontSize',
    'experience.web.workspace.treeFontSize',
  ]);
});

test('$owner inherits down its group, and absent means generic platform', () => {
  const byId = new Map(buildInventory().tokens.records.map((r) => [r.id, r]));
  // Group annotation reaches every leaf under it.
  assert.equal(byId.get('experience.web.terminalCapsule.tabHeight').owner, 'pattern.terminal-capsule');
  assert.equal(byId.get('experience.app.terminalCapsule.physKeyPadY').owner, 'pattern.terminal-capsule');
  assert.equal(byId.get('experience.web.workspace.editorFontSize').owner, 'pattern.file-workspace');
  // Leaf annotation inside an unowned family.
  assert.equal(byId.get('experience.web.shell.sessionRowPadY').owner, 'pattern.session-item');
  // A sibling in the same family that is shared across surfaces stays unowned.
  assert.equal(byId.get('experience.web.shell.sessionRowRadius').owner, null);
  // Generic platform vocabulary.
  assert.equal(byId.get('experience.web.control.md').owner, null);
});
