import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Canonical Browser Design test catalog (#1876 Phase A).
 *
 * The design Gate owns the mandatory browser subset. Workflows, the standalone
 * browser profile and the coalesced Full E2E verdict all consume this list
 * instead of restating spec paths — a second copy is how the design subset and
 * the full suite drift apart without either side noticing.
 *
 * `file` is repo-root-relative from `e2e/`'s point of view: Playwright runs
 * with `e2e/` as its cwd, so `tests/browser/<id>.spec.ts` is also the exact
 * argument the standalone profile passes.
 */
export const BROWSER_DESIGN_IDS = Object.freeze([
  'ui-contract-assertions',
  'ui-contract-matrix',
  'ui-contract-web',
  'design-renderer-boundary',
]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Resolve the canonical subset against a checkout.
 *
 * Absence is an error, never an empty selection: a missing file is exactly the
 * drift this catalog exists to catch, and an empty list would let the design
 * verdict pass over nothing.
 */
export function browserDesignTests(root = ROOT) {
  return BROWSER_DESIGN_IDS.map((id) => {
    const file = `tests/browser/${id}.spec.ts`;
    const absolute = join(root, 'e2e', file);
    if (!existsSync(absolute)) {
      throw new Error(`canonical Browser Design spec is missing: e2e/${file}`);
    }
    return { id, file, absolute };
  });
}

/**
 * Digest of the canonical selection: IDs, exact paths and spec content.
 *
 * The content hashes bind a verdict to the tests that actually ran, so a
 * report produced from a different revision (or a list edited between produce
 * and verify) cannot be attributed to this catalog. The Gate also pins the
 * exact SHA independently; this digest covers the *selection*.
 */
export function browserDesignDigest(root = ROOT) {
  const entries = browserDesignTests(root).map(({ id, file, absolute }) => ({
    id,
    file,
    sha256: sha256(readFileSync(absolute)),
  }));
  return { digest: sha256(JSON.stringify(entries)), entries };
}

export function browserDesignSpecPaths(root = ROOT) {
  return browserDesignTests(root).map(({ file }) => file);
}
