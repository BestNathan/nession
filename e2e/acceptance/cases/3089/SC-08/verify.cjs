'use strict';
// #3089 SC-08: the revised operation-surface prototype demonstrates the real
// Select boundary and Env anatomy, is pinned at an immutable prototype commit,
// and the live public Pages gallery publishes exactly that reviewed tree. The
// browser verifier performs the click-through separately; this verifier proves
// source identity and publication.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const REPO = 'BestNathan/nession';
const SLUG = 'session-operation-surfaces-3089';
const REVIEWED_SHA = 'f3c0e8dd0f85f93c6dd3174ba6134c3af138c228';
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
      'User-Agent': 'nession-3089-sc08-readback',
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

  // The reviewed revision and the published source must carry the same
  // prototype tree. A later prototype-branch commit is acceptable only while
  // this prototype is byte-identical to the reviewed revision.
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

  // The source states the Select/Env correction and keeps the mock boundary.
  assert.ok(reviewed['README.md'].includes('#3089'), 'README must link the owning Issue');
  for (const marker of [
    'data-location-trigger',
    'data-location-option',
    'EnvFileMultiSelect',
    '224px',
    'content-sized Location Select',
  ]) {
    assert.ok(reviewed['README.md'].includes(marker), 'README is missing ' + marker);
  }
  assert.ok(
    /mock.*not.*(?:production )?Acceptance|not production Acceptance/is.test(reviewed['README.md']),
    'README must separate mock evidence from production Acceptance',
  );
  for (const marker of ['data-location-trigger', 'data-location-option', 'data-env-multi']) {
    assert.ok(reviewed['app.js'].includes(marker), 'prototype app is missing ' + marker);
  }
  for (const forbidden of ['fetch(', 'new WebSocket', 'XMLHttpRequest']) {
    assert.ok(
      !reviewed['app.js'].includes(forbidden),
      'prototype must not use ' + forbidden,
    );
  }

  // The live public page is the prototype and names the published revision.
  const liveHtml = await read(PROTOTYPE_URL);
  assert.ok(liveHtml.includes('Session operation surfaces'), 'published page is the prototype');
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
        publishedSha + '; README states the content-sized Location Select, data-location-trigger/option, ' +
        'EnvFileMultiSelect 224px anatomy and the non-production boundary',
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
        'The revised #3089 operation-surface prototype ' + REVIEWED_SHA +
        ' is source-verified and published unchanged at ' + publishedSha +
        '; the Select/Env correction is present and the mock boundary is stated',
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
            'the revised prototype source or its public Pages gallery/preview could not be matched',
        },
      ],
    }) + '\n',
  );
  process.exitCode = 1;
});
