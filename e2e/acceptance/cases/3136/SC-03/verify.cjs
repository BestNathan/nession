'use strict';
// #3136 SC-03: the existing #3089 prototype is revised in place at an
// immutable orphan commit and the public Pages gallery publishes exactly that
// reviewed tree. The browser verifier performs the mock walkthrough separately.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const REPO = 'BestNathan/nession';
const SLUG = 'session-operation-surfaces-3089';
const REVIEWED_SHA = '94ac14d1b623d1f4dde6d1c8c9c70302c17ee853';
const MANIFEST_URL = 'https://bestnathan.github.io/nession/prototypes/manifest.json';
const PROTOTYPE_URL =
  'https://bestnathan.github.io/nession/prototypes/' + SLUG + '/index.html';
const FILES = ['index.html', 'README.md', 'app.js', 'styles.css'];

async function read(url, { json = false } = {}) {
  const host = new URL(url).hostname;
  assert.ok(
    ['bestnathan.github.io', 'raw.githubusercontent.com'].includes(host),
    'unexpected public read host ' + host,
  );
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'nession-3136-sc03-readback',
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

  // The source states the revised relationship and the mock boundary.
  for (const marker of [
    '#3089',
    '#3136',
    '32px Web',
    '44px App',
    'Field-alignment revision',
    'production parity',
  ]) {
    assert.ok(reviewed['README.md'].includes(marker), 'README is missing ' + marker);
  }
  for (const marker of [
    "'add-location'",
    'project-path-input',
    'data-location-editor=',
    'rows="1"',
  ]) {
    assert.ok(
      reviewed['app.js'].includes(marker),
      'prototype app is missing ' + marker,
    );
  }
  for (const marker of [
    'min-height:32px;max-height:160px;padding:4px 10px',
    'min-height:44px;field-sizing:content',
    'align-self:stretch;width:100%',
  ]) {
    assert.ok(
      reviewed['styles.css'].includes(marker),
      'prototype styles are missing ' + marker,
    );
  }
  for (const forbidden of ['fetch(', 'new WebSocket', 'XMLHttpRequest']) {
    assert.ok(
      !reviewed['app.js'].includes(forbidden),
      'prototype must not use ' + forbidden,
    );
  }

  const liveHtml = await read(PROTOTYPE_URL);
  assert.ok(liveHtml.includes('Field alignment #3136'), 'published page carries the #3136 revision');
  assert.ok(liveHtml.includes('Issue #3089'), 'published page names its owning prototype');

  const evidence = [
    {
      type: 'pages',
      value:
        'public manifest source=' + publishedSha + '; gallery entry ' + SLUG + ' -> ' +
        entry.preview + '; the live page carries the Field alignment #3136 revision',
    },
    {
      type: 'source',
      value:
        REVIEWED_SHA + '/' + SLUG + '/{' + FILES.join(',') + '} equals the published tree at ' +
        publishedSha + '; README states the #3089/#3136 relationship, 32px Web / 44px App field ' +
        'band, in-place revision and production-parity boundary; styles and app carry the compact ' +
        'top-aligned Directory/Agent rule',
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
        'The #3136 revision of the #3089 prototype ' + REVIEWED_SHA +
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
          value: 'the pinned prototype revision or its public Pages tree could not be matched',
        },
      ],
    }) + '\n',
  );
  process.exitCode = 1;
});
