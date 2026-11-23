'use strict';
// Public GitHub evidence captured by a separate trusted main workflow step.
// Case code consumes *only* this uncredentialed snapshot, never GH_TOKEN.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { targetSha } = require('../../shared/control-mode-cases.cjs');

let cached;
function readCaptured(route) {
  const file = process.env.NESSION_CASE3072_GITHUB_SNAPSHOT;
  if (!file) return null; // Original standalone/uncredentialed Case behavior.
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push',
    'snapshot accepted only on canonical main push');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  if (!cached) {
    cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(cached.schema_version, 1);
    assert.equal(cached.repository, 'BestNathan/nession');
    assert.equal(cached.issue, 3072);
    assert.equal(cached.target_sha, targetSha(),
      'stale/foreign trusted source bundle');
    assert.ok(cached.routes && typeof cached.routes === 'object' &&
      !Array.isArray(cached.routes));
  }
  assert.ok(Object.hasOwn(cached.routes, route),
    'missing original authenticated GitHub evidence route: ' + route);
  const entry = cached.routes[route];
  assert.ok(entry && (entry.status === 200 || entry.status === 404));
  assert.ok(entry.format === 'json' || entry.format === 'text');
  return entry;
}
module.exports = { readCaptured };
