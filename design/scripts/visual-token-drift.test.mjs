import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {
  PINNED_LEGACY_BASELINE_BLOB,
  collectNonTokenSourceMetrics,
  findNonTokenCssMetrics,
  findNonTokenInlineMetrics,
  findNonTokenMetricUtilities,
  gitBlobSha,
  isShippingStyleFile,
  readLegacyMetricBaseline,
  rejectNewMetricDebt,
} from './visual-token-drift.mjs';
import {scanNonTokenStyleSource} from './visual-vocabulary-source.mjs';

const FILE = 'web/src/product/example/components/Thing.tsx';

test('global token-only classifier rejects raw spacing/size and preserves structural layout', () => {
  assert.deepEqual(
    findNonTokenMetricUtilities('flex grid min-w-0 gap-0 w-full h-full gap-[var(--nession-rhythm-inline)] px-[var(--nession-panel-padding)]'),
    [],
  );
  assert.deepEqual(
    findNonTokenMetricUtilities('gap-2 md:p-3 -mt-4 w-8 h-[40px] px-[calc(var(--nession-panel-padding)+2px)]')
      .map(x => x.token),
    ['gap-2', 'md:p-3', '-mt-4', 'w-8', 'h-[40px]', 'px-[calc(var(--nession-panel-padding)+2px)]'],
  );
});

test('CSS and inline styles cannot hide non-token visual metrics', () => {
  assert.equal(findNonTokenCssMetrics('.x { gap: 12px; padding: var(--nession-panel-padding); }').length, 1);
  assert.equal(findNonTokenCssMetrics('.x { gap: 0; width: 100%; }').length, 0);
  assert.equal(findNonTokenCssMetrics('.x { color: #fff; box-shadow: 0 0 6px #000; }').length, 2);
  assert.equal(findNonTokenCssMetrics('.x { color: var(--nession-foreground); }').length, 0);
  assert.deepEqual(findNonTokenInlineMetrics('style={{ padding: 12, gap: 0, width: 44 }}')
    .map(x => x.token), ['padding: 12', 'width: 44']);
  assert.deepEqual(findNonTokenInlineMetrics('const stats = { width: 44, height: 120 };'), []);
});

test('immutable original source is grandfathered, edited file with old values is rejected', () => {
  const source = "export const c = 'flex gap-2 p-3';\n";
  const baseline = {schema_version: 1, files: {[FILE]: [gitBlobSha(source)]}};
  assert.deepEqual(scanNonTokenStyleSource(source, FILE, baseline), []);
  const edited = "export const c = 'flex gap-2 p-3';\nexport const changed = true;\n";
  assert.deepEqual(scanNonTokenStyleSource(edited, FILE, baseline).map(x => x.actual), ['gap-2', 'p-3']);
  const fixed = "export const c = 'flex gap-[var(--nession-rhythm-inline)] p-[var(--nession-panel-padding)]';\n";
  assert.deepEqual(scanNonTokenStyleSource(fixed, FILE, baseline), []);
  assert.ok(rejectNewMetricDebt(FILE, edited, collectNonTokenSourceMetrics(edited, FILE), baseline).length > 0);
});

test('unowned local variables and dynamic Tailwind metrics cannot circumvent the Gate', () => {
  const baseline = {schema_version: 1, files: {}};
  const local = "export const cls = 'gap-[var(--nession-local-spacing)]';";
  assert.deepEqual(
    scanNonTokenStyleSource(local, FILE, baseline).map(x => x.kind),
    ['untokenized-unowned-local-variable'],
  );
  const dynamic = 'export const cls = `gap-${density}`;';
  assert.deepEqual(
    scanNonTokenStyleSource(dynamic, FILE, baseline).map(x => x.kind),
    ['untokenized-dynamic-visual-class'],
  );
  assert.deepEqual(
    scanNonTokenStyleSource('export const cls = "gap-[var(--nession-rhythm-inline)]";', FILE, baseline),
    [],
  );
});

test('new files never inherit a legacy blob exemption', () => {
  assert.deepEqual(
    scanNonTokenStyleSource("export const c = 'gap-3';", FILE, {schema_version: 1, files: {}})
      .map(x => x.actual),
    ['gap-3'],
  );
  assert.deepEqual(scanNonTokenStyleSource('export const c = "gap-3";',
    'web/src/product/example/__tests__/test.ts', {schema_version: 1, files: {}}), []);
  assert.equal(isShippingStyleFile('web/src/product/example/Thing.tsx'), true);
  assert.equal(isShippingStyleFile('web/src/generated/protocol.ts'), false);
});

test('frozen Git blob baseline has an explicit immutable SHA and audited origins', () => {
  const source = readFileSync(new URL('../contracts/visual-token-debt.json', import.meta.url), 'utf8');
  assert.equal(gitBlobSha(source), PINNED_LEGACY_BASELINE_BLOB);
  const manifest = readLegacyMetricBaseline();
  assert.equal(manifest.schema_version, 1);
  assert.ok(Object.keys(manifest.files).length > 500);
  assert.ok(manifest.source_revisions.main && manifest.source_revisions.staging);
  assert.notEqual(gitBlobSha(source + '\n'), PINNED_LEGACY_BASELINE_BLOB);
});
