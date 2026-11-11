'use strict';
// #3089 SC-06: the Web/App operation prototype is clickable, public-safe and
// version-pinned, and its public preview status is verifiable. The read-only
// Agent cannot see the orphan prototype branch or HTTP, so this criterion is
// proven by an executable readback of the pinned source and public publication.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const REPO = 'BestNathan/nession';
const REVIEWED_SHA = '8a9b670b4b82d93cec48bad81d24c8d677119659';
const MANIFEST_URL = 'https://bestnathan.github.io/nession/prototypes/manifest.json';
const PROTOTYPE_URL =
  'https://bestnathan.github.io/nession/prototypes/session-operation-surfaces-3089/index.html';
const MARKERS = ['attach-quick', 'attach-config', 'choose-location', 'choose-env', 'create-session', 'project-create'];

async function read(url, { json = false } = {}) {
  const host = new URL(url).hostname;
  assert.ok(
    ['bestnathan.github.io', 'raw.githubusercontent.com'].includes(host),
    'unexpected public read host ' + host,
  );
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'nession-3089-sc06-readback',
      'Cache-Control': 'no-cache',
      Accept: json ? 'application/vnd.github+json' : '*/*',
    },
    redirect: 'error',
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(25_000),
  });
  assert.equal(response.status, 200, 'HTTP ' + response.status + ' ' + new URL(url).pathname);
  return json ? response.json() : response.text();
}

async function main() {
  const sha = targetSha();
  const manifest = await read(MANIFEST_URL, { json: true });
  assert.equal(manifest.schema_version, 1);
  const publishedSha = String(manifest.source?.sha ?? '');
  assert.match(publishedSha, /^[a-f0-9]{40}$/, 'public prototype manifest must pin a source SHA');
  const entry = (manifest.entries ?? []).find(
    (item) => item.slug === 'session-operation-surfaces-3089',
  );
  assert.ok(entry, 'session-operation-surfaces-3089 must be in the public prototype manifest');
  assert.equal(entry.preview, 'prototypes/session-operation-surfaces-3089/index.html');
  assert.ok(entry.source.includes(publishedSha), 'manifest entry must pin the published source');

  // The reviewed revision and the currently published source both carry the
  // Web/App operation journeys. Raw source proves the immutable revision.
  const raw = (revision, file) =>
    'https://raw.githubusercontent.com/' + REPO + '/' + revision +
    '/session-operation-surfaces-3089/' + file;
  const reviewedHtml = await read(raw(REVIEWED_SHA, 'index.html'));
  const reviewedJs = await read(raw(REVIEWED_SHA, 'app.js'));
  const publishedHtml = await read(raw(publishedSha, 'index.html'));
  const publishedJs = await read(raw(publishedSha, 'app.js'));
  for (const [label, html, js] of [
    ['reviewed', reviewedHtml, reviewedJs],
    ['published', publishedHtml, publishedJs],
  ]) {
    assert.ok(html.includes('Session operation surfaces'), label + ' HTML is missing the prototype');
    assert.ok(html.includes('Web / App'), label + ' HTML is missing the Web/App journeys');
    for (const marker of MARKERS) {
      assert.ok(js.includes(marker), label + ' prototype JS is missing ' + marker);
    }
    // Public-safe deterministic mock: no API, terminal transport or network.
    for (const forbidden of ['fetch(', 'new WebSocket', 'XMLHttpRequest']) {
      assert.ok(!js.includes(forbidden), label + ' prototype must not use ' + forbidden);
    }
  }

  // The live public gallery serves the same prototype at the pinned revision.
  const liveHtml = await read(PROTOTYPE_URL + '?revision=' + publishedSha);
  assert.ok(liveHtml.includes('Session operation surfaces'), 'published page is the prototype');
  assert.ok(liveHtml.includes('Web / App'), 'published page exposes the Web/App journeys');

  const evidence = [
    {
      type: 'pages',
      value:
        'public manifest source=' + publishedSha +
        '; entry session-operation-surfaces-3089 -> ' + entry.preview +
        '; the live page and both the reviewed (' + REVIEWED_SHA +
        ') and published source carry the Web/App operation journeys',
    },
    {
      type: 'source',
      value:
        REVIEWED_SHA + '/session-operation-surfaces-3089/{index.html,app.js}: markers ' +
        MARKERS.join(', ') + '; no fetch/WebSocket/XMLHttpRequest in the mock',
    },
    {
      type: 'runtime',
      value: 'Acceptance target SHA ' + sha + '; reviewed prototype commit ' + REVIEWED_SHA,
    },
  ];
  process.stdout.write(
    JSON.stringify({
      status: 'pass',
      summary:
        'The Web/App operation prototype revision ' + REVIEWED_SHA +
        ' is a public-safe, version-pinned mock whose live Pages manifest and gallery publish it',
      evidence,
    }) + '\n',
  );
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      status: 'fail',
      summary: String(error && error.message ? error.message : error).slice(-4400),
      evidence: [
        {
          type: 'runtime',
          value:
            'the pinned prototype source or its public Pages manifest/gallery preview was not verified',
        },
      ],
    }) + '\n',
  );
  process.exitCode = 1;
});
