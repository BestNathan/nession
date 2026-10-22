import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BROWSER_DESIGN_IDS } from './browser-design-catalog.mjs';
import { proveFailClosed } from './prove-browser-design-fail-closed.mjs';

const SHA = 'a'.repeat(40);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nession-design-fail-closed-'));
  const dir = join(root, 'e2e', 'tests', 'browser');
  mkdirSync(dir, { recursive: true });
  for (const id of BROWSER_DESIGN_IDS) writeFileSync(join(dir, `${id}.spec.ts`), `// ${id}\n`);
  const report = {
    stats: {},
    suites: BROWSER_DESIGN_IDS.map((id) => ({
      file: `tests/browser/${id}.spec.ts`,
      specs: [{
        title: id,
        line: 1,
        file: `tests/browser/${id}.spec.ts`,
        tests: [{ status: 'expected', results: [{ retry: 0, status: 'passed' }] }],
      }],
    })),
  };
  const assertions = {
    schema_version: 1,
    kind: 'playwright_assertion_steps',
    tests: BROWSER_DESIGN_IDS.map((id) => ({
      id, title: id, line: 1, retry: 0, status: 'passed', assertions: 2,
    })),
  };
  return { root, report, assertions };
}

test('every mutated Browser Design evidence shape is rejected', () => {
  const { root, report, assertions } = fixture();
  try {
    const result = proveFailClosed({ report, assertions, root, sha: SHA, actualSha: SHA });
    assert.equal(result.status, 'Pass');
    assert.equal(result.negatives, 8);
    assert.deepEqual(result.rejected.sort(), [
      'corrupt-report', 'flaky', 'foreign-sha', 'mismatched-assertion',
      'missing-assertions', 'missing-id', 'skipped', 'zero-assertions',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without genuine passing evidence the proof does not silently pass', () => {
  const { root, report, assertions } = fixture();
  try {
    const broken = structuredClone(report);
    broken.suites = broken.suites.slice(0, -1);
    assert.throws(() => proveFailClosed({
      report: broken, assertions, root, sha: SHA, actualSha: SHA,
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
