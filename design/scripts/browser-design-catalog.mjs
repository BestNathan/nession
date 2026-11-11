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

/**
 * Approved cross-capability visual recipes (#3138).
 *
 * These are the capability-level invariants the canonical browser profile
 * enforces in `ui-contract-assertions.spec.ts`. Three things stay true by
 * construction:
 *
 * - the **values** are not here; each `parts` entry names a typography role in
 *   `design/contracts/patterns/*.json`, so the contract remains the one owner
 *   and a role change is one edit;
 * - every contract part must be declared here and every declared part must
 *   exist in the contract, so a new part cannot ship without an owner/repair
 *   path (checked by `capability-visual-catalog.test.mjs`);
 * - `owner` names the shared recipe component that must be repaired, not the
 *   consumer that happens to render it.
 *
 * `relationalParts` are roles whose owner is a shared *primitive* rather than a
 * chrome role (the field label is the shared `Label`); the invariant there is
 * that independent consumers resolve the same computed style, not that they
 * name a typography token.
 */
const frozenParts = (web, app) => Object.freeze({ web: Object.freeze(web), app: Object.freeze(app) });

export const CAPABILITY_VISUAL_INVARIANTS = Object.freeze([
  Object.freeze({
    id: 'capability-detail-typography',
    pattern: 'pattern.resource-detail',
    contract: 'design/contracts/patterns/resource-detail.json',
    owner: 'web/src/components/ui/resource-detail.tsx',
    checkedBy: 'e2e/tests/browser/ui-contract-assertions.spec.ts',
    parts: frozenParts(
      ['detail-title', 'detail-section-title', 'detail-fact-label', 'detail-fact-value'],
      ['detail-section-title', 'detail-fact-label', 'detail-fact-value'],
    ),
    repair: 'render the part through DetailHeader/DetailSection/DetailFact; do not fork the type role in a consumer',
  }),
  Object.freeze({
    id: 'capability-read-only-facts',
    pattern: 'pattern.resource-detail',
    contract: 'design/contracts/patterns/resource-detail.json',
    owner: 'web/src/components/ui/resource-detail.tsx',
    checkedBy: 'e2e/tests/browser/ui-contract-assertions.spec.ts',
    relationalParts: frozenParts(['detail-fact'], ['detail-fact']),
    repair: 'render observed state as DetailFact; a read-only fact must not borrow input, fieldset or disabled-control chrome',
  }),
  Object.freeze({
    id: 'capability-form-typography',
    pattern: 'pattern.configuration-form',
    contract: 'design/contracts/patterns/configuration-form.json',
    owner: 'web/src/components/ui/configuration-form.tsx',
    checkedBy: 'e2e/tests/browser/ui-contract-assertions.spec.ts',
    parts: frozenParts(
      ['form-section-title', 'form-section-description', 'form-help', 'form-error'],
      ['form-section-title', 'form-section-description', 'form-help', 'form-error'],
    ),
    relationalParts: frozenParts(['form-label'], ['form-label']),
    repair: 'render sections/help/errors through FormSection/FormField; the field label stays the shared Label primitive',
  }),
  Object.freeze({
    id: 'capability-form-control-band',
    pattern: 'pattern.configuration-form',
    contract: 'design/contracts/patterns/configuration-form.json',
    owner: 'web/src/components/ui/configuration-form.tsx',
    checkedBy: 'e2e/tests/browser/ui-contract-assertions.spec.ts',
    controlField: 'controlHeightToken',
    repair: 'let shared Input/Button resolve the Experience control band; do not add a consumer-local height',
  }),
  Object.freeze({
    id: 'capability-operation-typography',
    pattern: 'pattern.operation-surface',
    contract: 'design/contracts/patterns/operation-surface.json',
    owner: 'web/src/components/ui/operation-surface.tsx',
    checkedBy: 'e2e/tests/browser/ui-contract-assertions.spec.ts',
    parts: frozenParts(
      ['operation-title', 'operation-error'],
      ['operation-error'],
    ),
    repair: 'use the shared Dialog title and OperationError roles; the App host header owns the operation name',
  }),
  Object.freeze({
    id: 'capability-operation-action-band',
    pattern: 'pattern.operation-surface',
    contract: 'design/contracts/patterns/operation-surface.json',
    owner: 'web/src/components/ui/operation-surface.tsx',
    checkedBy: 'e2e/tests/browser/ui-contract-assertions.spec.ts',
    controlField: 'controlHeightToken',
    repair: 'put shared Buttons in OperationActions; secondary before primary, both on the Experience control band',
  }),
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
