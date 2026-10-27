import test from 'node:test';
import assert from 'node:assert/strict';
import { prototypeNeedsRefresh, probePrototypeRefresh } from '../scripts/prototype-refresh-needed.mjs';

const head = 'a'.repeat(40);
const previous = 'b'.repeat(40);
const manifest = (sha, entries = []) => ({
  schema_version: 1,
  source: { branch: 'prototype', sha },
  entries,
});
const entry = {
  slug: 'agent-process-discovery-2514',
  source: 'https://github.com/BestNathan/nession/blob/' + head + '/agent-process-discovery-2514/index.html',
};
function response(json, status = 200) {
  return { ok: status === 200, status, json: async () => json };
}

test('unchanged published HEAD skips expensive Pages rebuild', () => {
  assert.equal(prototypeNeedsRefresh(head, manifest(head, [entry])), false);
  assert.equal(prototypeNeedsRefresh(head, manifest(previous)), true);
});

test('invalid, foreign, or incomplete published metadata cannot suppress deployment', () => {
  assert.equal(prototypeNeedsRefresh('bad', manifest('bad')), true);
  assert.equal(prototypeNeedsRefresh(head, { ...manifest(head), source: { branch: 'main', sha: head } }), true);
  assert.equal(prototypeNeedsRefresh(head, { ...manifest(head), entries: [ { ...entry, source: 'https://untrusted.invalid' } ] }), true);
  assert.equal(prototypeNeedsRefresh(head, { ...manifest(head), entries: null }), true);
  assert.equal(prototypeNeedsRefresh(head, null), true);
});

test('probe observes HEAD and published HTTPS using read-only identity; no prototype code execution', async () => {
  const requested = [];
  const result = await probePrototypeRefresh({
    fetchImpl: async (url, opts) => {
      requested.push({ url, opts });
      return response(requested.length === 1 ? { object: { sha: head } } : manifest(head, [entry]));
    },
  });
  assert.equal(result.changed, false);
  assert.equal(result.sourceSha, head);
  assert.equal(requested.length, 2);
  assert.match(requested[0].url, /api\.github\.com\/repos\/BestNathan\/nession\/git\/ref\/heads\/prototype$/);
  assert.match(requested[1].url, /bestnathan\.github\.io\/nession\/prototypes\/manifest\.json/);
});

test('stale online manifest triggers publishing', async () => {
  const result = await probePrototypeRefresh({ fetchImpl: async url =>
    response(url.includes('api.github.com') ? { object: { sha: head } } : manifest(previous))
  });
  assert.equal(result.changed, true);
});

test('network failures and missing Git ref fail open to trusted publishing', async () => {
  const failed = await probePrototypeRefresh({ fetchImpl: async () => { throw new Error('Network unavailable'); } });
  assert.equal(failed.changed, true);
  assert.match(failed.reason, /Network unavailable/);
  const missing = await probePrototypeRefresh({ fetchImpl: async () => response({}, 404) });
  assert.equal(missing.changed, true);
  assert.match(missing.reason, /404/);
});
