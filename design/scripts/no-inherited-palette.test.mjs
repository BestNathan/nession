import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Zero inheritance, asserted against the source files rather than a repo-wide
 * grep — a grep cannot tell `Inter` (the typeface) from `setInterval`, and
 * `oklch(1 0 0)` is literally both "pure white" and "zinc-50".
 *
 * The palette this product shipped with was inherited twice over: shadcn's
 * zinc ramp in the token source, and Catppuccin Mocha in the terminal. Both
 * were defaults nobody chose. This is what stops them coming back.
 */

const DESIGN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = join(DESIGN_DIR, '..');

function filesUnder(dir, extensions) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path, extensions));
    } else if (extensions.has(extname(entry))) {
      found.push(path);
    }
  }
  return found;
}

/** Every `oklch(L C H)` in the token source, with the file it came from. */
function oklchLiterals() {
  const found = [];
  for (const path of filesUnder(join(DESIGN_DIR, 'tokens'), new Set(['.json']))) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/g)) {
      found.push({
        file: relative(REPO_DIR, path),
        L: Number(match[1]),
        C: Number(match[2]),
        literal: match[0],
      });
    }
  }
  return found;
}

test('the token source carries no chroma-free grey ramp', () => {
  // A neutral ramp with chroma pinned at 0 is zinc's signature. Pure black and
  // pure white are legitimate primitives; a *ramp* between them is not — our
  // neutrals are cool-biased (hue 265) on purpose, so the warm location colour
  // has something to read against.
  const greys = oklchLiterals().filter(
    (c) => c.C === 0 && c.L !== 0 && c.L !== 1,
  );
  assert.deepEqual(
    greys.map((c) => `${c.file}: ${c.literal}`),
    [],
    'inherited chroma-free grey ramp in the token source',
  );
});

test('the token source names no foreign palette', () => {
  const offenders = [];
  for (const path of filesUnder(join(DESIGN_DIR, 'tokens'), new Set(['.json']))) {
    if (/catppuccin|mocha|zinc|nord|dracula|solarized/i.test(readFileSync(path, 'utf8'))) {
      offenders.push(relative(REPO_DIR, path));
    }
  }
  assert.deepEqual(offenders, [], 'token source still references an inherited palette');
});

test('web/src hardcodes no Catppuccin Mocha colour or identifier', () => {
  const MOCHA = /1e1e2e|cdd6f4|89b4fa|f5e0dc|a6e3a1|catppuccin/i;
  const offenders = [];
  for (const path of filesUnder(join(REPO_DIR, 'web', 'src'), new Set(['.ts', '.tsx', '.css']))) {
    const source = readFileSync(path, 'utf8');
    if (MOCHA.test(source)) {
      offenders.push(relative(REPO_DIR, path));
    }
  }
  assert.deepEqual(offenders, [], 'Catppuccin Mocha survived in web/src');
});

test('the token source and the generated terminal agree on a light ground', () => {
  const primitive = JSON.parse(readFileSync(join(DESIGN_DIR, 'tokens', 'primitive.json'), 'utf8'));
  // The terminal is the Session canvas: `terminal.background === ground` is how
  // "the terminal is not a card" (composition.md §4) becomes structural rather
  // than a convention someone has to remember.
  assert.equal(primitive.light.neutral.ground.value, 'oklch(1 0 0)');
  assert.equal(primitive.terminal.background.value.toLowerCase(), '#ffffff');
});
