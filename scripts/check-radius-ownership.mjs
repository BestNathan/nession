#!/usr/bin/env node
/**
 * Static gate: App-owned surfaces must use semantic radius tokens, not generic
 * Tailwind `rounded-*` utilities.
 *
 * The semantic radius hierarchy (#1110) is:
 * - radius-control (10px): interactive controls (buttons, inputs)
 * - radius-surface (16px): contained surfaces (panels, cards)
 * - radius-capsule (22px): the capsule, and everything that stands in its slot
 * - radius.pill (9999px): true pill/chip geometry
 *
 * The capsule tier covers the resting Capsule, the Context Capsule that opens
 * above it, the Peek that replaces the latter in place, and the child overlay a
 * Peek opens. They share one corner because they share one position: a surface
 * that takes another's slot reads as a different family when its corner does
 * not match, and 12px beside 22px did.
 *
 * `radius-floating` (20px, "temporary elevated surfaces: Peek, popovers,
 * inspectors") was removed on 2026-10-04. Its one documented consumer was the
 * Peek, and the owner converged the Peek onto the capsule's corner rather than
 * the other way — so the tier had no surface left to describe, and the 4-tier
 * hierarchy above is the one to read.
 *
 * Generic `rounded-{sm|md|lg|xl|2xl}` utilities are unowned — they have no
 * semantic meaning and no product role. App-owned surfaces (not components/ui/)
 * must use semantic tokens instead.
 *
 * Exemptions:
 * - `components/ui/*` — shadcn primitives are upstream, not Nession-owned
 * - `rounded-full` — already correct (circle geometry)
 * - Arbitrary values with `calc()` — layout arithmetic, not radius choice
 *
 * Usage:
 *   node scripts/check-radius-ownership.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const WEB_SRC = join(ROOT, 'web/src');

const GENERIC_RADIUS_RE = /\brounded-(?:sm|md|lg|xl|2xl)\b/g;
const EXEMPT_DIRS = ['components/ui'];

function shouldExempt(relativePath) {
  return EXEMPT_DIRS.some((dir) => relativePath.startsWith(dir + '/') || relativePath === dir);
}

function scanFile(filePath, relativePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment lines (single-line // or block comments starting with *)
    if (/^\s*(\/\/|\*)/.test(line)) continue;

    for (const match of line.matchAll(GENERIC_RADIUS_RE)) {
      violations.push({
        file: relativePath,
        line: i + 1,
        actual: match[0],
        expected: 'a semantic radius token (e.g., rounded-[var(--radius-control)])',
        owner: 'design/tokens/semantic.json',
        repair: 'replace the generic utility with a semantic radius token',
      });
    }
  }

  return violations;
}

function scanDirectory(dir, baseDir) {
  const violations = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const relativePath = relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      if (shouldExempt(relativePath)) continue;
      violations.push(...scanDirectory(fullPath, baseDir));
    } else if (entry.isFile() && /\.(tsx|ts|jsx|js)$/.test(entry.name)) {
      violations.push(...scanFile(fullPath, relativePath));
    }
  }

  return violations;
}

const violations = scanDirectory(WEB_SRC, WEB_SRC);

if (violations.length > 0) {
  console.error('DESIGN_SYSTEM_VIOLATION: unowned radius literals found\n');
  for (const v of violations) {
    console.error(`file: ${v.file}`);
    console.error(`line: ${v.line}`);
    console.error(`rule: no-generic-radius`);
    console.error(`actual: ${v.actual}`);
    console.error(`expected: ${v.expected}`);
    console.error(`owner: ${v.owner}`);
    console.error(`repair: ${v.repair}`);
    console.error('');
  }
  console.error(`✗ ${violations.length} violation(s) found`);
  console.error('  Fix: replace generic rounded-* utilities with semantic radius tokens');
  process.exit(1);
}

console.log('✓ check-radius-ownership (no generic radius literals in App-owned surfaces)');
