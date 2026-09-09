import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTokens } from './generate-tokens.mjs';
import {
  buildTokenIndex,
  loadContractSources,
  mergeContracts,
  parseCssPx,
  validateTree,
} from './resolve-contracts.mjs';

const TOKENS = loadTokens();
const REAL = loadContractSources();

// ── parseCssPx ──────────────────────────────────────────────────────────────

test('parseCssPx handles px/rem/plain-number and rejects colors', () => {
  assert.equal(parseCssPx(44), 44);
  assert.equal(parseCssPx('32px'), 32);
  assert.equal(parseCssPx('0.5rem'), 8);
  assert.equal(parseCssPx('1rem'), 16);
  assert.equal(parseCssPx('#22c55e'), null);
  assert.equal(parseCssPx('280ms'), null);
  assert.equal(parseCssPx(null), null);
});

// ── token index ─────────────────────────────────────────────────────────────

test('token index exposes experience, domain, primitive and semantic aliases', () => {
  const index = buildTokenIndex(TOKENS);
  assert.ok(index.has('experience.web.control.md'));
  assert.ok(index.has('experience.app.touchTarget.min'));
  assert.ok(index.has('experience.web.row.md'));
  assert.ok(index.has('primitive.typography.size'));
  assert.ok(index.has('domain.agent.online'));
  assert.ok(index.has('semantic.themes.light.success'));
  assert.ok(index.has('semantic.success'), 'semantic alias resolves via light theme');
  assert.ok(!index.has('experience.web.touchTarget.min'), 'web has no touch-target token');
  assert.ok(!index.has('semantic.nope'));
});

// ── inheritance merge (real sources) ────────────────────────────────────────

test('session-item: shipped two-line summary row — wrap allowed, clip, app touch target', () => {
  const merged = mergeContracts(REAL, TOKENS)['pattern.session-item'];
  assert.deepEqual(merged.extends, []);
  assert.deepEqual(merged.web, { wrap: true, overflow: 'clip' });
  assert.equal(merged.app.wrap, true);
  assert.equal(merged.app.overflow, 'clip');
  assert.equal(merged.app.heightToken, undefined, 'row height is layout-derived, not token-pinned');
  assert.equal(merged.app.touchTargetToken, 'experience.app.touchTarget.min');
  assert.equal(merged.app.touchTargetTokenPx, 44);
  assert.equal(merged.web.touchTargetToken, undefined);
});

test('session-list: pattern-level scroll overrides the global clip default', () => {
  const merged = mergeContracts(REAL, TOKENS)['pattern.session-list'];
  assert.equal(merged.web.overflow, 'scroll');
  assert.equal(merged.web.scrollOwner, 'self');
  assert.equal(merged.app.overflow, 'scroll');
  assert.equal(merged.app.heightToken, undefined, 'row density stays on session-item');
});

test('terminal-toolbar: chrome + control merge; app sheet overflow wins', () => {
  const merged = mergeContracts(REAL, TOKENS)['pattern.terminal-toolbar'];
  assert.deepEqual(merged.extends, ['category.chrome', 'category.control']);
  assert.equal(merged.web.wrap, false);
  assert.equal(merged.web.heightToken, 'experience.web.control.md');
  assert.equal(merged.web.heightTokenPx, 32);
  assert.equal(merged.web.overflow, 'menu');
  assert.equal(merged.web.justify, 'space-between');
  assert.equal(merged.app.overflow, 'sheet');
  assert.equal(merged.app.heightTokenPx, 44);
  assert.equal(merged.app.touchTargetTokenPx, 44);
  assert.equal(merged.app.alignY, 'middle');
});

test('session-header inherits chrome band rules and distributes title/actions', () => {
  const merged = mergeContracts(REAL, TOKENS)['pattern.session-header'];
  assert.equal(merged.web.wrap, false);
  assert.equal(merged.web.justify, 'space-between');
  assert.equal(merged.web.alignY, 'middle');
  assert.equal(merged.app.justify, 'space-between');
  assert.equal(merged.app.touchTargetTokenPx, 44);
});

test('workspace-navigation: menu overflow both experiences, no pinned strip height', () => {
  const merged = mergeContracts(REAL, TOKENS)['pattern.workspace-navigation'];
  assert.equal(merged.web.overflow, 'menu');
  assert.equal(merged.web.justify, 'start');
  assert.equal(merged.web.heightToken, undefined, 'strip height is layout-derived, not token-pinned');
  assert.equal(merged.web.wrap, false, 'single-line entries via category.chrome');
  assert.equal(merged.app.overflow, 'menu');
  assert.equal(merged.app.justify, 'start');
  assert.equal(merged.app.heightToken, undefined);
  assert.equal(merged.app.touchTargetToken, 'experience.app.touchTarget.min');
});

test('every merged pattern keeps provenance and experience blocks', () => {
  const merged = mergeContracts(REAL, TOKENS);
  assert.equal(Object.keys(merged).length, 5);
  for (const pattern of Object.values(merged)) {
    assert.match(pattern.id, /^pattern\./);
    assert.match(pattern.patternRef, /^docs\/design\/design-system\/patterns\/.*\.md$/);
    assert.ok(pattern.web && typeof pattern.web === 'object');
    assert.ok(pattern.app && typeof pattern.app === 'object');
    for (const block of [pattern.web, pattern.app]) {
      assert.equal(block.overflowPx, undefined, 'non-token fields carry no px enrichment');
    }
  }
});

// ── validation negatives (crafted trees, real tokens) ──────────────────────

function baseTree() {
  const global = { $description: 'x', web: {}, app: {} };
  const categories = {
    'chrome.json': {
      id: 'category.chrome',
      $description: 'x',
      web: { wrap: false },
      app: { wrap: false, touchTargetToken: 'experience.app.touchTarget.min' },
    },
    'list-row.json': {
      id: 'category.list-row',
      $description: 'x',
      web: { heightToken: 'experience.web.row.md' },
      app: { heightToken: 'experience.app.row.md' },
    },
  };
  const patterns = {
    'session-item.json': {
      id: 'pattern.session-item',
      $description: 'x',
      extends: ['category.chrome', 'category.list-row'],
      patternRef: 'docs/design/design-system/patterns/session-item.md',
      web: {},
      app: {},
    },
  };
  return { global, categories, patterns };
}

function errorsOf(tree) {
  return validateTree(tree, TOKENS).errors;
}

test('unknown token id fails with context', () => {
  const tree = baseTree();
  tree.categories['list-row.json'].web.heightToken = 'experience.web.row.lg2';
  const errors = errorsOf(tree);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown token id "experience\.web\.row\.lg2"/);
  assert.match(errors[0], /list-row\.json\.web/);
});

test('non-px token in a height field fails', () => {
  const tree = baseTree();
  tree.categories['list-row.json'].web.heightToken = 'semantic.success';
  const errors = errorsOf(tree);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /does not resolve to a px\/rem value/);
});

test('raw px duplication is rejected as an unknown key', () => {
  const tree = baseTree();
  tree.patterns['session-item.json'].web.heightPx = 36;
  const errors = errorsOf(tree);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown key "heightPx"/);
});

test('unknown extends target fails', () => {
  const tree = baseTree();
  tree.patterns['session-item.json'].extends = ['category.chrome', 'category.list-row', 'category.nope'];
  const errors = errorsOf(tree);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /extends unknown category "category\.nope"/);
});

test('category extends cycle fails', () => {
  const tree = baseTree();
  tree.categories['chrome.json'].extends = ['category.list-row'];
  tree.categories['list-row.json'].extends = ['category.chrome'];
  const errors = errorsOf(tree);
  assert.ok(errors.some((error) => /category cycle/.test(error)));
});

test('unused category fails', () => {
  const tree = baseTree();
  tree.categories['control.json'] = {
    id: 'category.control',
    $description: 'x',
    web: {},
    app: {},
  };
  const errors = errorsOf(tree);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /category "category\.control" is not referenced/);
});

test('bad enum and missing patternRef fail', () => {
  const tree = baseTree();
  tree.categories['list-row.json'].app.overflow = 'banana';
  delete tree.patterns['session-item.json'].patternRef;
  const errors = errorsOf(tree);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => /overflow.*banana/.test(error)));
  assert.ok(errors.some((error) => /missing "patternRef"/.test(error)));
});

test('patternRef pointing at a missing doc fails', () => {
  const tree = baseTree();
  tree.patterns['session-item.json'].patternRef = 'docs/design/design-system/patterns/nope.md';
  const errors = errorsOf(tree);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /does not exist/);
});

test('bad visibility mode fails', () => {
  const tree = baseTree();
  tree.patterns['session-item.json'].app.visibility = { mode: 'explode' };
  const errors = errorsOf(tree);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /visibility\.mode "explode"/);
});

test('file/id mismatch fails', () => {
  const tree = baseTree();
  tree.patterns['renamed.json'] = tree.patterns['session-item.json'];
  delete tree.patterns['session-item.json'];
  const errors = errorsOf(tree);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /file renamed\.json does not match id "pattern\.session-item"/);
});

// ── real-directory smoke ────────────────────────────────────────────────────

test('committed sources validate clean and merge to 5 patterns', () => {
  const { errors, index } = validateTree(REAL, TOKENS);
  assert.deepEqual(errors, []);
  assert.ok(index.has('experience.app.touchTarget.min'));
  assert.equal(Object.keys(mergeContracts(REAL, TOKENS)).length, 5);
});
