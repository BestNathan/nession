import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import nessionPlugin from '../index.js';
import {
  findCrossExperienceVars,
  isAppScopedBinding,
} from '../rules/no-cross-experience-token.js';

const metadataPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../design/generated/lint-metadata.json',
);
const lintMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));

const CAPSULE = '/proj/web/src/product/terminal/capsule/capsuleStyles.ts';

// The rule this replaces could not fire on any input: its token list was a
// hand-written literal naming classes no generator emitted, and it compared
// whole whitespace-separated class tokens rather than the `var(--x)` form the
// code actually uses. It reported nothing for its entire life and no gate
// noticed (#771).
//
// So the first fixture is not about a violation at all — it is the guard that
// keeps the list derived. If it ever goes back to a literal that drifts from
// the token source, this fails instead of the rule going quiet.
test('the app-only token list is derived from the token source, not hand-listed', () => {
  const vars = lintMetadata.experienceAppVars;
  assert.ok(Array.isArray(vars) && vars.length > 0, 'experienceAppVars is empty or missing');

  // Present in experience/app.json only — emitted solely under [data-experience="app"].
  for (const appOnly of ['touch-target-min', 'touch-target-compact', 'composer-shell-inset']) {
    assert.ok(vars.includes(appOnly), `expected ${appOnly} in experienceAppVars`);
  }

  // Present in BOTH experiences (app overrides it). Emitted at :root, so it
  // resolves on Web too — flagging it would be a false positive.
  for (const shared of ['control-md', 'control-sm', 'icon-md']) {
    assert.ok(!vars.includes(shared), `${shared} is shared and must not be listed as app-only`);
  }
});

test('findCrossExperienceVars matches the var() form and ignores shared tokens', () => {
  assert.deepEqual(
    findCrossExperienceVars('inset-x-[length:var(--composer-shell-inset)]', lintMetadata),
    ['composer-shell-inset'],
  );
  assert.deepEqual(
    findCrossExperienceVars('bottom-[max(var(--composer-shell-inset),var(--composer-shell-safe-area))]', lintMetadata),
    ['composer-shell-inset', 'composer-shell-safe-area'],
  );
  // Shared and web-only tokens resolve in both experiences.
  assert.deepEqual(findCrossExperienceVars('h-[length:var(--control-md)]', lintMetadata), []);
  assert.deepEqual(findCrossExperienceVars('var(--composer-shell-margin-x)', lintMetadata), []);
  assert.deepEqual(findCrossExperienceVars(undefined, lintMetadata), []);
});

test('isAppScopedBinding reads the experience out of the binding name', () => {
  assert.equal(isAppScopedBinding('capsuleShellAppOuterClass'), true);
  assert.equal(isAppScopedBinding('capsuleQuickKeyAppRowClass'), true);
  assert.equal(isAppScopedBinding('capsuleShellWebOuterClass'), false);
  assert.equal(isAppScopedBinding('capsuleQuickKeyRowClass'), false);
  assert.equal(isAppScopedBinding(null), false);
});

const ruleTester = new RuleTester({
  parser: tseslint.parser,
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
});

test('no-cross-experience-token fails an App-only token outside an App-scoped binding', () => {
  ruleTester.run('no-cross-experience-token', nessionPlugin.rules['no-cross-experience-token'], {
    valid: [
      {
        code: 'export const capsuleShellAppOuterClass = "inset-x-[length:var(--composer-shell-inset)]";',
        filename: CAPSULE,
      },
      {
        code: 'export const capsuleShellWebOuterClass = "inset-x-[length:var(--composer-shell-margin-x)]";',
        filename: CAPSULE,
      },
      {
        // A shared token is legal in either experience.
        code: 'export const capsuleControlRowClass = "h-[length:var(--control-md)]";',
        filename: CAPSULE,
      },
    ],
    invalid: [
      {
        // The shape the rename corrected: App-only token, binding name silent
        // about the experience it belongs to.
        code: 'export const capsuleQuickKeyRowClass = "gap-[length:var(--composer-quick-key-gap)]";',
        filename: CAPSULE,
        errors: [{ messageId: 'violation' }],
      },
      {
        // No named binding at all — the author has not said which experience
        // this class belongs to, so the rule cannot clear it.
        code: 'export function Probe() { return <div className="inset-x-[length:var(--composer-shell-inset)]" />; }',
        filename: CAPSULE,
        errors: [{ messageId: 'violation' }],
      },
    ],
  });
});

test('the violation names the token, the binding, and the owner', () => {
  const rule = nessionPlugin.rules['no-cross-experience-token'];
  const reported = [];
  const context = {
    filename: CAPSULE,
    sourceCode: { getAncestors: () => [] },
    getSourceCode: () => ({ getAncestors: () => [] }),
    report(descriptor) {
      reported.push(descriptor);
    },
  };
  rule.create(context).Literal({ type: 'Literal', value: 'var(--touch-target-min)' });

  assert.equal(reported.length, 1);
  const message = rule.meta.messages.violation.replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => reported[0].data[key],
  );
  assert.match(message, /var\(--touch-target-min\)/);
  assert.match(message, /no named binding/);
  assert.match(message, /owner: {2}design\/tokens\/experience\/app\.json/);
  assert.match(message, /repair:/);
  assert.match(message, /nession\/no-cross-experience-token/);
});
