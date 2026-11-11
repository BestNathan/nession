import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_DESIGN_IDS,
  CAPABILITY_VISUAL_INVARIANTS,
} from './browser-design-catalog.mjs';
import { loadTokens } from './generate-tokens.mjs';
import { loadContractSources, mergeContracts } from './resolve-contracts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MERGED = mergeContracts(loadContractSources(), loadTokens());
const EXPERIENCES = ['web', 'app'];

/**
 * #3138: the browser catalog names the approved capability visual invariants,
 * and this test is what keeps that scope honest:
 *
 * - every declared part exists in the pattern contract and carries a role;
 * - every role-bearing contract part is declared, so a new part cannot ship
 *   without an owner and a repair path;
 * - the shared component that must be repaired and the canonical browser spec
 *   that checks it both exist and name the parts they own.
 *
 * Values are deliberately absent here. A size or band lives in
 * `design/contracts/patterns/*.json`; this test only proves the ownership map
 * is complete and resolvable.
 */
test('every capability visual invariant names a real owner, contract and check', () => {
  const ids = new Set();
  for (const invariant of CAPABILITY_VISUAL_INVARIANTS) {
    assert.ok(!ids.has(invariant.id), `duplicate invariant id: ${invariant.id}`);
    ids.add(invariant.id);

    assert.ok(typeof invariant.repair === 'string' && invariant.repair.length > 0,
      `${invariant.id} must name a concrete repair`);
    assert.ok(existsSync(join(ROOT, invariant.owner)),
      `${invariant.id} owner does not exist: ${invariant.owner}`);
    assert.ok(existsSync(join(ROOT, invariant.contract)),
      `${invariant.id} contract does not exist: ${invariant.contract}`);

    const checkedFile = invariant.checkedBy.replace(/^e2e\/tests\/browser\//, '').replace(/\.spec\.ts$/, '');
    assert.ok(BROWSER_DESIGN_IDS.includes(checkedFile),
      `${invariant.id} must be checked by a canonical browser design spec, got ${invariant.checkedBy}`);
    const checkSource = readFileSync(join(ROOT, invariant.checkedBy), 'utf8');

    const hasParts = invariant.parts !== undefined || invariant.relationalParts !== undefined;
    assert.ok(hasParts || invariant.controlField !== undefined,
      `${invariant.id} declares no part or control invariant`);

    const pattern = MERGED[invariant.pattern];
    assert.ok(pattern, `${invariant.id} names unknown pattern ${invariant.pattern}`);

    for (const [kind, declared] of [
      ['parts', invariant.parts],
      ['relationalParts', invariant.relationalParts],
    ]) {
      if (declared === undefined) continue;
      assert.deepEqual(Object.keys(declared).sort(), [...EXPERIENCES].sort(),
        `${invariant.id}.${kind} must state both experiences`);
      for (const experience of EXPERIENCES) {
        assert.ok(Array.isArray(declared[experience]) && declared[experience].length > 0,
          `${invariant.id}.${kind}.${experience} must list at least one part`);
        for (const part of declared[experience]) {
          assert.ok(checkSource.includes(part),
            `${invariant.id}: ${invariant.checkedBy} does not name part ${part}`);
          if (kind === 'parts') {
            const block = pattern[experience].parts?.[part];
            assert.ok(block, `${invariant.id}: ${invariant.pattern}.${experience}.parts.${part} is missing`);
            const hasRole = typeof block.typographyToken === 'string'
              || (Array.isArray(block.typographyTokens) && block.typographyTokens.length > 0);
            assert.ok(hasRole,
              `${invariant.id}: ${invariant.pattern}.${experience}.parts.${part} has no typography role`);
            const resolved = block.typography ?? block.typographies?.[0];
            assert.ok(resolved && Number.isFinite(resolved.sizePx),
              `${invariant.id}: ${part}.typography did not resolve`);
          }
        }
      }
    }

    if (invariant.controlField !== undefined) {
      for (const experience of EXPERIENCES) {
        assert.ok(typeof pattern[experience][invariant.controlField] === 'string',
          `${invariant.id}: ${invariant.pattern}.${experience}.${invariant.controlField} is missing`);
        assert.ok(Number.isFinite(pattern[experience][`${invariant.controlField}Px`]),
          `${invariant.id}: ${invariant.pattern}.${experience}.${invariant.controlField}Px did not resolve`);
      }
    }
  }
});

test('the contract has no role-bearing part outside the declared capability scope', () => {
  const declared = new Map();
  for (const invariant of CAPABILITY_VISUAL_INVARIANTS) {
    if (invariant.parts === undefined) continue;
    const parts = declared.get(invariant.pattern) ?? new Set();
    for (const experience of EXPERIENCES) {
      for (const part of invariant.parts[experience]) parts.add(part);
    }
    declared.set(invariant.pattern, parts);
  }

  for (const [patternId, pattern] of Object.entries(MERGED)) {
    for (const experience of EXPERIENCES) {
      for (const part of Object.keys(pattern[experience].parts ?? {})) {
        assert.ok(
          declared.get(patternId)?.has(part),
          `${patternId}.${experience}.parts.${part} has no capability visual invariant owner`,
        );
      }
    }
  }
});
