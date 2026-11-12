'use strict';
// #3142 SC-05: the overlay-system prototype is pinned at an immutable orphan
// commit and the public Pages gallery publishes exactly that reviewed tree.
// The browser verifier performs the mock walkthrough separately.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const REPO = 'BestNathan/nession';
const SLUG = 'overlay-system-3142';
const REVIEWED_SHA = '82945fb47342a98b8ac5ab2110247079060a285b';
const MANIFEST_URL = 'https://bestnathan.github.io/nession/prototypes/manifest.json';
const PROTOTYPE_URL = 'https://bestnathan.github.io/nession/prototypes/' + SLUG + '/index.html';
const FILES = ['index.html', 'README.md', 'app.js', 'styles.css'];

async function read(url, { json = false } = {}) {
  const host = new URL(url).hostname;
  assert.ok(
    ['bestnathan.github.io', 'raw.githubusercontent.com'].includes(host),
    'unexpected public read host ' + host,
  );
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'nession-3142-sc05-readback',
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
  const entry = (manifest.entries ?? []).find((item) => item.slug === SLUG);
  assert.ok(entry, SLUG + ' must be in the public prototype gallery manifest');
  assert.equal(entry.preview, 'prototypes/' + SLUG + '/index.html');
  assert.ok(entry.source.includes(publishedSha), 'gallery entry must pin the published source');

  // The reviewed pin and the published source must carry the same tree.
  const raw = (revision, file) =>
    'https://raw.githubusercontent.com/' + REPO + '/' + revision + '/' + SLUG + '/' + file;
  const reviewed = {};
  const published = {};
  for (const file of FILES) {
    reviewed[file] = await read(raw(REVIEWED_SHA, file));
    published[file] = await read(raw(publishedSha, file));
    assert.equal(
      published[file],
      reviewed[file],
      'published ' + file + ' must equal the reviewed revision',
    );
  }

  // The source states the product relationship and the mock boundary.
  for (const marker of ['#3142', '#3137', 'Compact', 'Standard', 'Wide', 'Pages']) {
    assert.ok(reviewed['README.md'].includes(marker), 'README is missing ' + marker);
  }
  assert.ok(
    /not independently Chromium-verified|not.*production/i.test(reviewed['README.md']),
    'README must state the fidelity/production boundary',
  );
  for (const marker of [
    'data-action="location-menu"',
    "ev.key==='Escape'",
    'class="dialog \'+role+\'"',
  ]) {
    assert.ok(
      reviewed['app.js'].includes(marker),
      'prototype app is missing ' + marker,
    );
  }
  for (const forbidden of ['fetch(', 'new WebSocket', 'XMLHttpRequest']) {
    assert.ok(
      !reviewed['app.js'].includes(forbidden),
      'prototype must not use ' + forbidden,
    );
  }

  const liveHtml = await read(PROTOTYPE_URL);
  assert.ok(liveHtml.includes('Overlay'), 'published page is the overlay prototype');
  assert.ok(liveHtml.includes(publishedSha), 'published page must name its source SHA');

  const evidence = [
    {
      type: 'pages',
      value:
        'public manifest source=' + publishedSha + '; gallery entry ' + SLUG + ' -> ' +
        entry.preview + '; the live page names that source SHA',
    },
    {
      type: 'source',
      value:
        REVIEWED_SHA + '/' + SLUG + '/{' + FILES.join(',') + '} equals the published tree at ' +
        publishedSha + '; README states the #3142/#3137 relationship, compact/standard/wide roles, ' +
        'Pages status and the mock boundary',
    },
    {
      type: 'runtime',
      value:
        'Acceptance target SHA ' + sha + '; reviewed prototype commit ' + REVIEWED_SHA +
        '; published source revision ' + publishedSha,
    },
  ];
  process.stdout.write(
    JSON.stringify({
      status: 'pass',
      summary:
        'The #3142 overlay prototype ' + REVIEWED_SHA +
        ' is source-verified and published unchanged at ' + publishedSha,
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
          value: 'the pinned overlay prototype or its public Pages revision could not be matched',
        },
      ],
    }) + '\n',
  );
  process.exitCode = 1;
});
