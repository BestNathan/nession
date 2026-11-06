'use strict';
// #2750 SC-05 runtime half: the Web design regression guard is canonical and
// fail-closed — ui-contract-web asserts both modality directions, the shared
// helper proofs reject an outset outline / added outer ring / pointer outline,
// no primitive reintroduces the 3px shadcn halo, and the design gate consumes
// the single browser-design catalog instead of a parallel E2E pipeline.
const fs = require('node:fs');
const path = require('node:path');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

function read(root, file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

run(({ evidence }) => {
  const sha = targetSha();
  const root = process.cwd();
  const uiDir = path.join(root, 'web/src/components/ui');
  if (!fs.existsSync(uiDir)) throw new Error('web/src/components/ui is missing from the target checkout');

  const catalog = read(root, 'design/scripts/browser-design-catalog.mjs');
  for (const id of ['ui-contract-web', 'ui-contract-assertions']) {
    if (!catalog.includes("'" + id + "'")) {
      throw new Error('canonical browser design catalog does not include ' + id);
    }
  }

  const webSpec = read(root, 'e2e/tests/browser/ui-contract-web.spec.ts');
  for (const needle of [
    'expectQuietPointerFocus',
    'expectInsetFocusOutline',
    '(#2750)',
    'aria-invalid',
  ]) {
    if (!webSpec.includes(needle)) throw new Error('ui-contract-web does not assert ' + needle);
  }

  const proofSpec = read(root, 'e2e/tests/browser/ui-contract-assertions.spec.ts');
  for (const needle of ['rejectsWith(expectInsetFocusOutline', 'rejectsWith(expectQuietPointerFocus']) {
    if (!proofSpec.includes(needle)) throw new Error('focus helper failure proof missing: ' + needle);
  }

  const gate = read(root, 'design/scripts/design-gate.mjs');
  if (!gate.includes('browserDesignSpecPaths')) {
    throw new Error('design gate does not consume the canonical browser-design catalog');
  }

  let primitives = 0;
  for (const name of fs.readdirSync(uiDir)) {
    if (!/\.(?:ts|tsx)$/.test(name)) continue;
    const source = read(root, path.join('web/src/components/ui', name));
    if (source.includes('focus-visible:ring-3') || source.includes('focus-visible:ring-[3px]')) {
      throw new Error(name + ' reintroduced an outer 3px focus ring');
    }
    primitives += 1;
  }
  if (primitives < 10) throw new Error('primitive scan found too few files: ' + primitives);

  const button = read(root, 'web/src/components/ui/button.tsx');
  if (!button.includes('outline-[length:var(--nession-focus-ring-width)]') ||
      !button.includes('outline-offset-[calc(-1*var(--nession-focus-ring-offset))]')) {
    throw new Error('button focus outline is not token-backed');
  }

  evidence.push({
    type: 'source',
    value: 'exact SHA ' + sha + ': canonical browser design catalog includes ui-contract-web and ' +
      'ui-contract-assertions; ui-contract-web asserts pointer-quiet and inset-outline modality; ' +
      'ui-contract-assertions proves both helpers reject an outset outline, an added outer ring and a ' +
      'pointer outline; ' + primitives + ' UI primitive sources contain no focus-visible:ring-3/[3px]; ' +
      'button focus consumes --nession-focus-ring-width/-offset; design-gate.mjs consumes browserDesignSpecPaths',
  });
  return 'the focus regression guard is canonical and fail-closed, not a parallel E2E pipeline';
});
