import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
