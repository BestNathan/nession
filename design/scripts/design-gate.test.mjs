import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkDrawnAffordanceBand,
  checkSemanticTokenIdentity,
  formatViolation,
  parseProfile,
  scanPrimitiveSource,
} from './design-gate.mjs';

test('semantic identity fails even when two token bands resolve to the same px', () => {
  const violations = checkSemanticTokenIdentity({
    pattern: 'pattern.terminal-capsule',
    expectedToken: 'control.md',
    actualToken: 'control.sm',
    resolvedPx: 44,
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'semantic-token-identity');
  assert.match(violations[0].note, /44px/);
});

test('semantic identity accepts the contract-named token', () => {
  assert.deepEqual(checkSemanticTokenIdentity({
    pattern: 'pattern.terminal-capsule',
    expectedToken: 'control.md',
    actualToken: 'control.md',
    resolvedPx: 44,
  }), []);
});

// #1034. The App capsule's control.sm and control.md are both 44px, so a control
// whose painted affordance grew back to the band is pixel-identical to one that
// kept a smaller circle — to every assertion that measures the element it is
// handed. These fixtures pin the drawn-affordance check, which is the only thing
// that can see the difference.
const DRAWN = {
  pattern: 'pattern.terminal-capsule',
  expectedToken: 'control.visualSize',
  actualToken: 'control.visualSize',
};

test('drawn affordance is accepted only while it stays below the hit target', () => {
  assert.deepEqual(
    checkDrawnAffordanceBand({ ...DRAWN, visualPx: 36, bandPx: 44, floorPx: 32 }),
    [],
    '36px inside a 44px target is the intended App geometry',
  );

  const grown = checkDrawnAffordanceBand({ ...DRAWN, visualPx: 44, bandPx: 44, floorPx: 32 });
  assert.equal(grown.length, 1);
  assert.equal(grown[0].rule, 'drawn-affordance-band');
  assert.match(grown[0].expected, /drawn affordance < 44px/);

  const shrunk = checkDrawnAffordanceBand({ ...DRAWN, visualPx: 28, bandPx: 44, floorPx: 32 });
  assert.deepEqual(shrunk.map((v) => v.rule), ['drawn-affordance-band']);
});

test('drawn affordance that names the hit-target band fails token identity', () => {
  // The revert this exists for: the class reaches for a control band instead of
  // the drawn-affordance token, which merges the two axes back into one. Both
  // spellings of that mistake are covered — the band it should have used, and
  // the smaller one the removed `capsuleSecondaryIconButtonClass` used to name.
  for (const actualToken of ['control.md', 'control.sm']) {
    const violations = checkDrawnAffordanceBand({
      ...DRAWN,
      actualToken,
      visualPx: 36,
      bandPx: 44,
      floorPx: 32,
    });
    assert.deepEqual(
      violations.map((v) => v.rule),
      ['drawn-affordance-token-identity'],
      `${actualToken} must not stand in for the drawn affordance`,
    );
  }
});

test('a drawn affordance with no numeric value violates instead of skipping', () => {
  const violations = checkDrawnAffordanceBand({
    ...DRAWN,
    visualPx: null,
    bandPx: 44,
    floorPx: 32,
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'drawn-affordance-band');
  assert.match(violations[0].actual, /no numeric value found/);
});

test('shadcn boundary rejects an arbitrary design metric fixture', () => {
  const violations = scanPrimitiveSource(
    'export function Probe() { return <button className="h-[34px] rounded-[7px]" />; }',
    'web/src/components/ui/probe.tsx',
  );

  assert.deepEqual(
    violations.map((item) => item.rule),
    ['no-ui-primitive-arbitrary-metric', 'no-ui-primitive-arbitrary-metric'],
  );
});

test('shadcn boundary rejects raw color but permits token-backed arbitrary values', () => {
  assert.equal(
    scanPrimitiveSource(
      'const bad = <div style={{ color: "#ff0000" }} />;',
      'web/src/components/ui/probe.tsx',
    )[0].rule,
    'no-ui-primitive-raw-color',
  );

  assert.deepEqual(
    scanPrimitiveSource(
      'const ok = <div className="h-[length:var(--control-md)] bg-background text-foreground" />;',
      'web/src/components/ui/probe.tsx',
    ),
    [],
  );
});

test('diagnostics are structured for agent repair loops', () => {
  const message = formatViolation({
    file: 'web/src/features/foo/Foo.tsx',
    rule: 'no-feature-magic-metric',
    actual: 'h-[34px]',
    expected: 'an Experience token',
    owner: 'design/tokens/experience/web.json',
    repair: 'use or extend the canonical token owner',
  });

  assert.match(message, /^DESIGN_SYSTEM_VIOLATION/m);
  assert.match(message, /file: web\/src\/features\/foo\/Foo.tsx/);
  assert.match(message, /rule: no-feature-magic-metric/);
  assert.match(message, /owner: design\/tokens\/experience\/web.json/);
  assert.match(message, /repair: use or extend the canonical token owner/);
});

test('full is the manual default and profiles are explicit', () => {
  assert.equal(parseProfile([]), 'full');
  assert.equal(parseProfile(['--profile', 'fast']), 'fast');
  assert.equal(parseProfile(['--profile', 'browser']), 'browser');
});

// #774 SC7. The direct-metric regex needs the bracket to hold nothing but a
// number, so a nested expression could pick a literal undisturbed — which is
// how `rounded-[min(var(--radius-md),10px)]` shipped in four primitives. These
// fixtures pin both halves: the nested literal fails, and a token-backed
// dynamic expression stays legal, so the rule cannot be satisfied by banning
// arbitrary values outright.
test('shadcn boundary rejects a design literal nested in an arbitrary value', () => {
  const rules = (source) =>
    scanPrimitiveSource(source, 'web/src/components/ui/probe.tsx').map((v) => v.rule);

  assert.deepEqual(
    rules('export const c = "rounded-[min(var(--radius-md),10px)]";'),
    ['no-ui-primitive-nested-design-literal'],
  );
  assert.deepEqual(
    rules('export const c = "max-w-[calc(100%-2rem)]";'),
    [],
    'calc() is arithmetic against a resolved dimension, not a design choice',
  );
  assert.deepEqual(
    rules('export const c = "rounded-[min(var(--radius-md),var(--radius-lg))]";'),
    [],
    'a token-backed dynamic expression is the point of an arbitrary value',
  );
  assert.deepEqual(
    rules('export const c = "gap-[--spacing(var(--gap))]";'),
    [],
  );

  // The two rules partition the space — `h-[34px]` is not reported twice.
  assert.deepEqual(
    rules('export const c = "h-[34px]";'),
    ['no-ui-primitive-arbitrary-metric'],
  );
});
