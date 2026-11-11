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
  assert.ok(index.has('experience.web.control.visualSize'));
  assert.ok(index.has('experience.app.control.visualSize'));
  assert.ok(index.has('experience.app.touchTarget.min'));
  assert.ok(index.has('experience.web.row.md'));
  assert.ok(index.has('primitive.typography.size'));
  assert.ok(index.has('domain.agent.online'));
  assert.ok(index.has('semantic.themes.light.warning'));
  assert.ok(index.has('semantic.warning'), 'semantic alias resolves via light theme');
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

test('terminal-capsule: chrome + control merge; app sheet overflow wins', () => {
  const merged = mergeContracts(REAL, TOKENS)['pattern.terminal-capsule'];
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

// #1034: the drawn affordance is the second axis. Its resolved px is what makes
// "a 44px hit target holding a 36px painted circle" checkable, and on App the
// height token alone cannot express it — control.sm and control.md are 44px
// there, so a control that grew its painting back to the band would be
// pixel-identical to one that kept the smaller circle.
test('CSS-valued contract tokens use the canonical --nession-* namespace', () => {
  const merged = mergeContracts(REAL, TOKENS);
  for (const id of [
    'pattern.context-capsule',
    'pattern.terminal-capsule',
    'pattern.workspace-navigation',
  ]) {
    for (const experience of ['web', 'app']) {
      const css = merged[id][experience].radiusTokenCss;
      assert.ok(css, `${id}.${experience}.radiusTokenCss is missing`);
      assert.match(css, /var\(--nession-/);
      assert.doesNotMatch(css, /var\(--(?!nession-)/);
    }
  }
});

test('terminal-capsule: the drawn affordance resolves below the App hit target', () => {
  const merged = mergeContracts(REAL, TOKENS)['pattern.terminal-capsule'];
  assert.equal(merged.web.visualSizeToken, 'experience.web.control.visualSize');
  assert.equal(merged.web.visualSizeTokenPx, 32);
  assert.equal(merged.app.visualSizeToken, 'experience.app.control.visualSize');
  assert.equal(merged.app.visualSizeTokenPx, 36);
  assert.ok(
    merged.app.visualSizeTokenPx < merged.app.heightTokenPx,
    'the App drawn affordance stays strictly inside the hit target',
  );
});

// #3138: the shared content recipes name their data-recipe-part anatomy, and
// this is the one owner of what each part must resolve. The browser check
// consumes these values; the spec contains no second copy of 16px/12.5px/etc.
test('content recipes resolve each declared part to its approved typography role', () => {
  const merged = mergeContracts(REAL, TOKENS)['pattern.resource-detail'];
  assert.equal(merged.web.parts['detail-title'].typographyToken, 'experience.web.typography.title');
  assert.deepEqual(merged.web.parts['detail-title'].typography, {
    sizePx: 16,
    weight: 600,
    lineHeight: 1.25,
    sizeVar: '--nession-typography-title-size',
    weightVar: '--nession-typography-title-weight',
    lineHeightVar: '--nession-typography-title-line-height',
  });
  assert.equal(merged.web.parts['detail-section-title'].typography.sizePx, 12.5);
  assert.equal(merged.app.parts['detail-section-title'].typography.sizePx, 13);
  assert.deepEqual(
    merged.web.parts['detail-fact-value'].typographies.map((role) => role.sizePx),
    [13, 12.5],
    'a fact value may be body for product text and code for technical identity',
  );
  assert.equal(
    merged.app.parts['detail-title'],
    undefined,
    'the App host header owns the surface name; content must not repeat it',
  );

  const form = mergeContracts(REAL, TOKENS)['pattern.configuration-form'];
  assert.equal(form.web.controlHeightToken, 'experience.web.control.md');
  assert.equal(form.web.controlHeightTokenPx, 32);
  assert.equal(form.app.controlHeightTokenPx, 44);
  assert.equal(form.app.parts['form-section-title'].typography.sizePx, 13);
  assert.equal(
    form.web.parts['form-label'],
    undefined,
    'the field label is owned by the shared Label primitive, not a chrome role',
  );

  const operation = mergeContracts(REAL, TOKENS)['pattern.operation-surface'];
  assert.equal(operation.web.parts['operation-title'].typography.sizePx, 16);
  assert.equal(operation.app.parts['operation-title'], undefined);
  assert.equal(operation.app.controlHeightTokenPx, 44);
});

test('session-header inherits chrome band rules and distributes title/actions', () => {
  const merged = mergeContracts(REAL, TOKENS)['pattern.session-header'];
  assert.equal(merged.web.wrap, false);
  assert.equal(merged.web.justify, 'space-between');
  assert.equal(merged.web.alignY, 'middle');
  assert.equal(merged.app.justify, 'space-between');
  assert.equal(merged.app.touchTargetTokenPx, 44);
});

test('workspace-navigation: self-scrolling overflow both experiences, no pinned strip height', () => {
  const merged = mergeContracts(REAL, TOKENS)['pattern.workspace-navigation'];
  // #1347 Capsule V2: the capsule carries the capability list and scrolls
  // itself, so its overflow strategy is `scroll` rather than the More/menu
  // disclosure the pattern required before. The bound moved from the entry
  // count to the capsule's own width — see the patternRef doc.
  assert.equal(merged.web.overflow, 'scroll');
  assert.equal(merged.web.justify, 'start');
  assert.equal(merged.web.heightToken, undefined, 'strip height is layout-derived, not token-pinned');
  // Labeled slots: a long name wraps to two lines inside its fixed-width slot,
  // so the pattern overrides the chrome category's single-line default and the
  // single-line guarantee lives on the slot's line clamp (owner follow-up,
  // 2026-10-03). The row itself stays one horizontal row of slots.
  assert.equal(merged.web.wrap, true, 'labeled slots may wrap inside the slot');
  assert.equal(merged.app.overflow, 'scroll');
  assert.equal(merged.app.justify, 'start');
  assert.equal(merged.app.heightToken, undefined);
  assert.equal(merged.app.wrap, true);
  // Owner decision 2026-10-03 (#1347 SC-08 / SC-29): on App this band is one
  // state of the same Capsule as the Conversation form, so its entries carry
  // the standard App control band (`control.md` hit target, `control.visualSize`
  // affordance) and the pattern declares no floor of its own. The compact
  // override it used to carry (#730) retired with the two tokens that fed it.
  assert.equal(merged.app.touchTargetToken, 'experience.app.touchTarget.min');
  assert.equal(merged.app.touchTargetTokenPx, 44);
});

test('a pattern may declare its own touch floor without changing the category', () => {
  const merged = mergeContracts(REAL, TOKENS);

  // The override is local: patterns that declare nothing keep the chrome default.
  assert.equal(merged['pattern.session-header'].app.touchTargetToken, 'experience.app.touchTarget.min');
  assert.equal(merged['pattern.session-header'].app.touchTargetTokenPx, 44);
  assert.equal(merged['pattern.workspace-navigation'].app.touchTargetTokenPx, 44);

  // No real contract overrides the floor anymore — workspace-navigation was the
  // only one, and the 2026-10-03 Capsule-family decision retired it. The
  // mechanism is still part of the merge, so it is asserted with a fixture:
  // session-header's app block is re-pointed at a token with a *different*
  // resolved size (32 ≠ 44), which only passes if the merge honors the local
  // declaration rather than the category default.
  const header = REAL.patterns['session-header.json'];
  const fixture = {
    ...REAL,
    patterns: {
      ...REAL.patterns,
      'session-header.json': {
        ...header,
        app: { ...header.app, touchTargetToken: 'experience.web.control.md' },
      },
    },
  };
  const overridden = mergeContracts(fixture, TOKENS)['pattern.session-header'];
  assert.equal(overridden.app.touchTargetToken, 'experience.web.control.md');
  assert.equal(overridden.app.touchTargetTokenPx, 32);
  assert.equal(
    mergeContracts(REAL, TOKENS)['pattern.session-header'].app.touchTargetTokenPx,
    44,
    'the real contract still resolves to the chrome floor — the fixture replaced, never added',
  );
});

test('every merged pattern keeps provenance and experience blocks', () => {
  const merged = mergeContracts(REAL, TOKENS);
  // The count is read from the sources rather than written here: the set of
  // patterns *is* the files in `design/contracts/patterns/`, and a literal made
  // every new pattern edit a test whose subject is provenance.
  assert.equal(Object.keys(merged).length, Object.keys(REAL.patterns).length);
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
  tree.categories['list-row.json'].web.heightToken = 'semantic.warning';
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

test('a typography part must name a role group, not an arbitrary token', () => {
  const tree = baseTree();
  tree.patterns['session-item.json'].web.parts = {
    'row-title': { typographyToken: 'experience.web.typography.nope' },
  };
  const errors = errorsOf(tree);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /is not a typography role \(missing size, weight, lineHeight\)/);

  const leafTree = baseTree();
  leafTree.patterns['session-item.json'].web.parts = {
    'row-title': { typographyToken: 'experience.web.typography.title.size' },
  };
  const leafErrors = errorsOf(leafTree);
  assert.equal(leafErrors.length, 1);
  assert.match(leafErrors[0], /is not a typography role/);
});

test('a part must declare an approved field and a role', () => {
  const tree = baseTree();
  tree.patterns['session-item.json'].web.parts = {
    'row-title': { fontSize: '16px' },
    'row-meta': {},
    'row-both': {
      typographyToken: 'experience.web.typography.title',
      typographyTokens: ['experience.web.typography.body'],
    },
    'row-empty-list': { typographyTokens: [] },
  };
  const errors = errorsOf(tree);
  assert.equal(errors.length, 4);
  assert.ok(errors.some((error) => /unknown key "fontSize"/.test(error)));
  assert.ok(errors.some((error) => /declares no approved role/.test(error)));
  assert.ok(errors.some((error) => /names both typographyToken and typographyTokens/.test(error)));
  assert.ok(errors.some((error) => /typographyTokens must be a non-empty array/.test(error)));
});

test('part names must be kebab-case and parts must be an object', () => {
  const tree = baseTree();
  tree.patterns['session-item.json'].web.parts = {
    Row_Title: { typographyToken: 'experience.web.typography.title' },
  };
  const errors = errorsOf(tree);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must be a kebab-case data-recipe-part name/);

  const arrayTree = baseTree();
  arrayTree.patterns['session-item.json'].web.parts = [];
  const arrayErrors = errorsOf(arrayTree);
  assert.equal(arrayErrors.length, 1);
  assert.match(arrayErrors[0], /must be an object of data-recipe-part names/);
});

test('part geometry and controlHeightToken must resolve to px', () => {
  const tree = baseTree();
  tree.patterns['session-item.json'].web.parts = {
    'row-title': { heightToken: 'semantic.warning' },
  };
  tree.patterns['session-item.json'].web.controlHeightToken = 'semantic.warning';
  const errors = errorsOf(tree);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => /does not resolve to a px\/rem value/.test(error)));
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

test('committed sources validate clean and merge to every declared pattern', () => {
  const { errors, index } = validateTree(REAL, TOKENS);
  assert.deepEqual(errors, []);
  assert.ok(index.has('experience.app.touchTarget.min'));
  assert.equal(
    Object.keys(mergeContracts(REAL, TOKENS)).length,
    Object.keys(REAL.patterns).length,
  );
});

test('real viewport matrix carries the canonical web/app rows', () => {
  const rows = REAL.viewports.viewports;
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.map((row) => row.id), [
    'web.small-laptop',
    'web.narrow-laptop',
    'web.compact-laptop',
    'web.standard-desktop',
    'web.wide-desktop',
    'app.narrow-phone',
    'app.standard-phone',
    'app.large-phone',
    'app.landscape-phone',
  ]);
  assert.ok(rows.every((row) => Number.isInteger(row.width) && Number.isInteger(row.height)));
  // Orientation is not a field in the schema — `width > height` is the only
  // signal, so every consumer has to re-derive it. Asserted for the App rows
  // specifically: the Web rows are all landscape by nature (they are desktop
  // viewports), so the meaningful claim is that exactly one *mobile* viewport
  // is, and a row that loses its orientation fails loudly here.
  const appLandscape = rows.filter(
    (row) => row.experience === 'app' && row.width > row.height,
  );
  assert.deepEqual(appLandscape.map((row) => row.id), ['app.landscape-phone']);
});

test('duplicate viewport id fails', () => {
  const tree = baseTree();
  tree.viewports = {
    viewports: [
      { id: 'web.standard-desktop', experience: 'web', role: 'a', width: 1440, height: 900 },
      { id: 'web.standard-desktop', experience: 'web', role: 'b', width: 1280, height: 800 },
    ],
  };
  const errors = errorsOf(tree);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /duplicates viewport id "web\.standard-desktop"/);
});

test('viewport with wrong experience or non-integer size fails', () => {
  const tree = baseTree();
  tree.viewports = {
    viewports: [
      { id: 'app.narrow-phone', experience: 'ios', role: 'a', width: 375, height: 812 },
      { id: 'web.wide-desktop', experience: 'web', role: 'b', width: 1920, height: 1080.5 },
    ],
  };
  const errors = errorsOf(tree);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => /experience "ios" must be web or app/.test(error)));
  assert.ok(errors.some((error) => /height must be a positive integer/.test(error)));
});

test('viewport entry with unknown key or malformed id fails', () => {
  const tree = baseTree();
  tree.viewports = {
    viewports: [
      { id: 'app/standard', experience: 'app', role: 'a', width: 390, height: 844, density: '2x' },
    ],
  };
  const errors = errorsOf(tree);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => /unknown key "density"/.test(error)));
  assert.ok(errors.some((error) => /must be "<experience>\.<slug>"/.test(error)));
});
