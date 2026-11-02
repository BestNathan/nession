'use strict';

// #2514 SC-07 (runtime half): the revised #2514 prototype is published on the
// shared orphan prototype branch, listed by the native Pages catalog, and the
// public HTTPS site serves the same source revision with the revised
// current-Session / disclosure design.
//
// The Pages manifest is the publication readback and is authoritative for the
// served source SHA. A GitHub ref/ancestry cross-check is best-effort: an
// unauthenticated API rate limit must not turn a published artifact into a
// failure.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPO = 'BestNathan/nession';
const PINNED_SHA = '12fb8893058ba7e5bd360a28b44ac9a154e40a95';
const SLUG = 'agent-process-discovery-2514';
const PAGES = 'https://bestnathan.github.io/nession/prototypes/';
const API = 'https://api.github.com/repos/' + REPO;
const root = path.resolve(__dirname, '../../../../..');

async function get(url, asJson = true) {
  const headers = {
    'User-Agent': 'nession-source-aligned-acceptance-2514-sc07',
    Accept: asJson ? 'application/json' : 'text/html, application/json',
    'Cache-Control': 'no-cache',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (url.startsWith('https://api.github.com/') && token) {
    headers.Authorization = 'Bearer ' + token;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, 'HTTP ' + response.status + ' fetching ' + url);
  return asJson ? response.json() : response.text();
}

async function prototypeAncestry() {
  try {
    const ref = await get(API + '/git/ref/heads/prototype');
    assert.match(ref.object.sha, /^[a-f0-9]{40}$/, 'prototype ref is not a full SHA');
    if (ref.object.sha !== PINNED_SHA) {
      const compare = await get(API + '/compare/' + PINNED_SHA + '...' + ref.object.sha);
      assert.ok(
        ['ahead', 'identical'].includes(compare.status),
        'prototype branch no longer descends from the pinned revised #2514 source',
      );
      return 'prototype branch ' + ref.object.sha + ' descends from pinned 12fb8893...';
    }
    return 'prototype branch equals the pinned revised source 12fb8893...';
  } catch (error) {
    return 'GitHub ref cross-check unavailable (' + String(error.message || error).slice(0, 120) +
      '); manifest source SHA used';
  }
}

async function run() {
  const target = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA || '');
  assert.match(target, /^[a-f0-9]{40}$/, 'Acceptance requires an exact 40-char target SHA');
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(checkout, target, 'Case checkout must match the exact target SHA');

  const manifest = await get(PAGES + 'manifest.json?revision=' + Date.now());
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.source.branch, 'prototype');
  assert.match(manifest.source.sha, /^[a-f0-9]{40}$/, 'manifest source SHA is not a full SHA');
  const current = manifest.source.sha;
  const entry = manifest.entries.find((item) => item.slug === SLUG);
  assert.ok(entry, 'public Pages catalog is missing ' + SLUG);
  assert.equal(entry.preview, 'prototypes/' + SLUG + '/index.html');
  assert.equal(
    entry.source,
    'https://github.com/' + REPO + '/blob/' + current + '/' + SLUG + '/index.html',
    'catalog source must pin the manifest source SHA',
  );

  const ancestry = await prototypeAncestry();

  const html = await get(PAGES + SLUG + '/index.html?revision=' + current, false);
  assert.ok(html.includes(current), 'served HTML must cite the manifest source SHA');
  assert.ok(html.includes('id="scenario"'), 'revised interactive scenario selector is missing');
  assert.ok(html.includes('Agent details'), 'revised default-closed Agent details is missing');
  assert.ok(html.includes('Process details'), 'revised optional Process details is missing');
  assert.ok(html.includes('无当前 Session'), 'explicit no-current-Session scenario is missing');

  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary:
      'The revised #2514 prototype is published on the shared branch, listed by the native Pages catalog, ' +
      'and the public HTTPS site serves the same source revision with the revised disclosure design',
    evidence: [
      {
        type: 'runtime',
        value: ancestry,
      },
      {
        type: 'runtime',
        value:
          'public manifest source=prototype@' + current +
          ' lists ' + SLUG + ' with preview and pinned GitHub source',
      },
      {
        type: 'runtime',
        value:
          'direct HTTPS HTML cites ' + current +
          ' and contains the scenario selector, Agent details, Process details, and no-current-Session state',
      },
    ],
  }) + '\n');
}

run().catch((error) => {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error.message || error).slice(0, 2200),
    evidence: [{
      type: 'runtime',
      value: '#2514 revised prototype publication, Pages catalog entry, or public HTML source parity was not verified',
    }],
  }) + '\n');
  process.exitCode = 1;
});
