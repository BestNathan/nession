import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APP_VIEWPORT_OWNER_ROOT,
  KEYBOARD_SCROLL_OWNER_FILE,
  KEYBOARD_SCROLL_OWNER_MARKER,
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

test('Nession-owned shared recipes require token-backed visual metrics (#4050)', () => {
  const recipe = 'web/src/components/ui/resource-detail.tsx';
  const form = 'web/src/components/ui/configuration-formStyles.ts';

  const bad = 'className="flex gap-3 p-2.5 -mt-4 w-6 gap-[12px] gap-[calc(1rem+var(--nession-rhythm-inline))]"';
  const violations = scanLayoutSource(bad, recipe);
  assert.equal(violations.length, 6);
  assert.ok(violations.every(v => v.kind === 'no-recipe-raw-spacing' && v.owner && v.repair));
  assert.ok(violations.some(v => v.actual.includes('gap-[calc(1rem')));

  assert.deepEqual(
    rules(scanLayoutSource("export const formRowClass = 'gap-2 p-3';", form)),
    ['no-recipe-raw-spacing', 'no-recipe-raw-spacing'],
    'a shared style-string owner is still a Recipe',
  );
  assert.deepEqual(
    rules(scanLayoutSource('<div style={{ padding: 12 }} />', recipe)),
    ['no-recipe-raw-spacing'],
    'inline non-token visual lengths cannot bypass the class check',
  );
});

test('Nession recipe tokens and structural layout remain legal (#4050)', () => {
  const source =
    '<div className="flex min-w-0 grid-cols-1 gap-0 p-0 gap-[var(--nession-rhythm-inline)] p-[var(--nession-shell-space-3)]" />';
  for (const recipe of [
    'web/src/components/ui/resource-detail.tsx',
    'web/src/components/ui/configuration-form.tsx',
    'web/src/components/ui/operation-surface.tsx',
  ]) {
    assert.deepEqual(scanLayoutSource(source, recipe), [], recipe);
  }
  assert.deepEqual(
    scanLayoutSource('<div className="flex gap-3 p-3" />', 'web/src/components/ui/label.tsx'),
    [],
    'upstream Label interior geometry is not blanket-ported to Nession recipe ownership',
  );
});

test('only the App Experience owns the keyboard-avoidance scroll ancestor', () => {
  const marker = `data-keyboard-avoidance-scrollport=""`;
  assert.deepEqual(
    rules(scanLayoutSource(`<div ${marker} />`, 'web/src/capabilities/files/components/Pane.tsx')),
    ['no-foreign-keyboard-scroll-owner'],
  );
  assert.deepEqual(
    scanLayoutSource(`<div ${marker} />`, KEYBOARD_SCROLL_OWNER_FILE),
    [],
    'the Experience scrollport is the one owner',
  );
});

test('only the App viewport environment reads window.visualViewport', () => {
  assert.deepEqual(
    rules(scanLayoutSource(
      'const height = window.visualViewport?.height ?? 0;',
      'web/src/platform/terminal-runtime/view/TerminalGeometry.ts',
    )),
    ['no-foreign-visual-viewport'],
  );
  assert.deepEqual(
    rules(scanLayoutSource(
      'const height = window.visualViewport?.height ?? 0;',
      'web/src/capabilities/terminal/components/Surface.tsx',
    )),
    ['no-foreign-visual-viewport'],
  );
  assert.deepEqual(
    scanLayoutSource(
      'const viewport = window.visualViewport;',
      `${APP_VIEWPORT_OWNER_ROOT}AppViewportEnvironment.ts`,
    ),
    [],
    'the environment is the documented read owner',
  );
  assert.deepEqual(
    rules(scanLayoutSource(
      'const viewport = window.visualViewport;',
      'web/src/product/terminal/capsule/hooks/useThing.ts',
    )),
    ['no-foreign-visual-viewport'],
    'a second visual-viewport reader outside AppLayout is a competing owner',
  );
});

test('the committed tree satisfies layout ownership', () => {
  assert.deepEqual(scanRepository(), []);
});
