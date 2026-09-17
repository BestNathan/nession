import { test } from 'node:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import nessionPlugin from '../index.js';

// This rule had no fixture at all, and its glob still pointed at
// `src/session-first/` after the shell moved to `src/app/`. It therefore
// matched zero files and reported nothing, forever, with no signal (issue
// #759). The `valid` case that names the old path is the one that pins the
// scope: if the glob regresses, the rule goes quiet again and this fails.
const APP = '/proj/web/src/app/';
const OLD_SHELL = '/proj/web/src/session-first/';

const ruleTester = new RuleTester({
  parser: tseslint.parser,
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
});

test('no-sf-overlay-vars still guards the retired --sf-* vocabulary', () => {
  ruleTester.run('no-sf-overlay-vars', nessionPlugin.rules['no-sf-overlay-vars'], {
    valid: [
      {
        code: 'export const x = "var(--shell-space-2)";',
        filename: `${APP}SessionFirstShell.tsx`,
      },
      {
        code: 'export const x = "var(--shell-space-2)";',
        filename: `${OLD_SHELL}SessionFirstShell.tsx`,
      },
      {
        // Test files legitimately spell the retired name.
        code: 'export const x = "var(--sf-rail-width)";',
        filename: `${APP}__tests__/shell.test.ts`,
      },
    ],
    invalid: [
      {
        code: 'export const x = "var(--sf-rail-width)";',
        filename: `${APP}SessionFirstShell.tsx`,
        errors: [{ messageId: 'violation' }],
      },
      {
        code: 'export function Probe() { return <div className="w-[var(--sf-sidebar-width)]" />; }',
        filename: `${APP}patterns/SidebarSectionHead.tsx`,
        errors: [{ messageId: 'violation' }],
      },
    ],
  });
});
