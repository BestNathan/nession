import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LAYOUT_RECIPE_OWNER,
  MASTER_DETAIL_MARKER,
  SCROLL_OWNER_MARKER,
  scanLayoutSource,
  scanRepository,
} from './layout-ownership.mjs';

const rules = (violations) => violations.map((violation) => violation.kind).sort();

test('capability content cannot take page geometry or the App header', () => {
  const source = [
    'export function Bad() {',
    '  return (',
    '    <div className="fixed inset-0 flex min-h-[100dvh] flex-col">',
    '      <AppPageHeader title="Mine" onBack={() => {}} backLabel="Back" />',
    '    </div>',
    '  );',
    '}',
  ].join('\n');
  const violations = scanLayoutSource(source, 'web/src/capabilities/bad/components/Bad.tsx');
  assert.deepEqual(rules(violations), [
    'no-capability-app-header',
    'no-capability-frame-geometry',
  ]);
  assert.ok(violations.every((violation) => violation.owner && violation.repair));
});

test('capability content cannot publish host Workspace chrome', () => {
  const violations = scanLayoutSource(
    '<div data-testid="workspace-tool-bar" />',
    'web/src/product/bad/Bad.tsx',
  );
  assert.deepEqual(rules(violations), ['no-capability-host-chrome']);
  assert.match(violations[0].repair, /Workspace host/);
});

test('local flex/grid composition and the issue example stay legal', () => {
  const source = [
    'export function Local({ wide }: { wide: boolean }) {',
    "  return <div className={cn('flex min-w-0 flex-col', wide && 'min-h-0 flex-1')} />;",
    '}',
  ].join('\n');
  assert.deepEqual(
    scanLayoutSource(source, 'web/src/capabilities/good/components/Good.tsx'),
    [],
    'mechanisms are not a forbidden syntax',
  );
  assert.deepEqual(
    scanLayoutSource('<div className="h-[100dvh]" />', 'web/src/app/experiences/app/AppLayers.tsx'),
    [],
    'the Experience frame owns page geometry',
  );
});

test('comments and tests are not execution', () => {
  assert.deepEqual(
    scanLayoutSource(
      '// h-screen belongs to the frame, never capability content\nconst x = 1;',
      'web/src/capabilities/good/components/Good.tsx',
    ),
    [],
  );
  assert.deepEqual(
    scanLayoutSource('<div className="h-screen" />', 'web/src/capabilities/bad/__tests__/Bad.test.tsx'),
    [],
  );
});

test('the stable master/detail grid has one owner', () => {
  const duplicated = `className="grid h-full ${MASTER_DETAIL_MARKER} overflow-hidden"`;
  assert.deepEqual(
    rules(scanLayoutSource(duplicated, 'web/src/app/experiences/web/OtherWebLayout.tsx')),
    ['no-duplicated-master-detail'],
  );
  assert.deepEqual(
    scanLayoutSource(duplicated, LAYOUT_RECIPE_OWNER),
    [],
    'the recipe owner states the stable class',
  );
});

test('the host scroll marker has one owner', () => {
  assert.deepEqual(
    rules(scanLayoutSource(`<div ${SCROLL_OWNER_MARKER}="true" />`, 'web/src/app/experiences/web/Other.tsx')),
    ['no-duplicated-scroll-owner'],
  );
  assert.deepEqual(
    scanLayoutSource(`<div ${SCROLL_OWNER_MARKER}="true" />`, LAYOUT_RECIPE_OWNER),
    [],
  );
});

test('the shared recipes do not encode raw numeric spacing', () => {
  assert.deepEqual(
    rules(scanLayoutSource('<div className="flex flex-col gap-3 p-4" />', LAYOUT_RECIPE_OWNER)),
    ['no-recipe-raw-spacing', 'no-recipe-raw-spacing'],
  );
  assert.deepEqual(
    scanLayoutSource(
      '<div className="flex flex-col gap-[var(--nession-shell-space-2)]" />',
      LAYOUT_RECIPE_OWNER,
    ),
    [],
    'a token-backed spacing role is the repair',
  );
});

test('the committed tree satisfies layout ownership', () => {
  assert.deepEqual(scanRepository(), []);
});
