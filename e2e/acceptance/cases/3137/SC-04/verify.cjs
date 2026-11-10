'use strict';
// #3137 SC-04: the three existing prototypes are revised in place at one
// immutable orphan commit, and the public Pages gallery publishes exactly that
// reviewed tree. The browser verifier performs the mock walks separately.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const REPO = 'BestNathan/nession';
const REVIEWED_SHA = 'fc09bf0613adfd0b451ff28c292311b0e6f4292c';
const MANIFEST_URL = 'https://bestnathan.github.io/nession/prototypes/manifest.json';

const PROTOTYPES = [
  {
    slug: 'project-session-3025',
    files: ['index.html', 'README.md', 'app.js', 'styles.css'],
    readmeMarkers: ['#3137', 'ResourceDetail', 'ConfigurationForm', 'OperationSurface', '32px', '44px'],
    appMarkers: ['detail-section', 'detail-fact', 'form-section', 'formSection('],
    liveMarkers: ['Issue #3137', '#3137:'],
  },
  {
    slug: 'sandbox-capability-3124',
    files: ['index.html', 'README.md', 'app.js'],
    readmeMarkers: ['#3137', 'ResourceDetail', 'ConfigurationForm', 'OperationSurface', '32px', '44px', 'Chromium'],
    appMarkers: ['config-destination-state', 'confirm-enter', 'data-action="validate"'],
    liveMarkers: ['#3137 presentation revision'],
  },
  {
    slug: 'session-operation-surfaces-3089',
    files: ['index.html', 'README.md', 'app.js', 'styles.css'],
    readmeMarkers: ['#3137', 'ConfigurationForm', 'OperationSurface', '32px', '44px'],
    appMarkers: ['formSection(', 'form-section', "formSection('Identity'"],
    liveMarkers: ['#3137 revision'],
  },
];

async function read(url, { json = false } = {}) {
  const host = new URL(url).hostname;
  assert.ok(
    ['bestnathan.github.io', 'raw.githubusercontent.com'].includes(host),
    'unexpected public read host ' + host,
  );
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'nession-3137-sc04-readback',
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

  const evidence = [];
  for (const prototype of PROTOTYPES) {
    const entry = (manifest.entries ?? []).find((item) => item.slug === prototype.slug);
    assert.ok(entry, prototype.slug + ' must be in the public prototype gallery manifest');
    assert.equal(entry.preview, 'prototypes/' + prototype.slug + '/index.html');
    assert.ok(entry.source.includes(publishedSha), 'gallery entry must pin the published source');

    const raw = (revision, file) =>
      'https://raw.githubusercontent.com/' + REPO + '/' + revision + '/' + prototype.slug + '/' + file;
    const reviewed = {};
    for (const file of prototype.files) {
      reviewed[file] = await read(raw(REVIEWED_SHA, file));
      const published = await read(raw(publishedSha, file));
      assert.equal(
        published,
        reviewed[file],
        'published ' + prototype.slug + '/' + file + ' must equal the reviewed revision',
      );
    }

    for (const marker of prototype.readmeMarkers) {
      assert.ok(
        reviewed['README.md'].includes(marker),
        prototype.slug + ' README is missing ' + marker,
      );
    }
    for (const marker of prototype.appMarkers) {
      assert.ok(
        reviewed['app.js'].includes(marker),
        prototype.slug + ' app is missing ' + marker,
      );
    }
    for (const forbidden of ['fetch(', 'new WebSocket', 'XMLHttpRequest']) {
      assert.ok(
        !reviewed['app.js'].includes(forbidden),
        prototype.slug + ' must not use ' + forbidden,
      );
    }

    const liveHtml = await read(
      'https://bestnathan.github.io/nession/prototypes/' + prototype.slug + '/index.html',
    );
    for (const marker of prototype.liveMarkers) {
      assert.ok(
        liveHtml.includes(marker),
        'published ' + prototype.slug + ' page is missing ' + marker,
      );
    }
    evidence.push({
      type: 'pages',
      value:
        prototype.slug + ' -> ' + entry.preview + '; reviewed and published trees equal at ' +
        publishedSha + '; live page carries the #3137 revision',
    });
  }

  evidence.push({
    type: 'source',
    value:
      REVIEWED_SHA + '/{' + PROTOTYPES.map((item) => item.slug).join(',') +
      '} equals the published tree at ' + publishedSha +
      '; READMEs state the ResourceDetail/ConfigurationForm/OperationSurface relationship, ' +
      '32px Web / 44px App bands and the in-place prototype boundary',
  });
  evidence.push({
    type: 'runtime',
    value:
      'Acceptance target SHA ' + sha + '; reviewed prototype commit ' + REVIEWED_SHA +
      '; published source revision ' + publishedSha,
  });

  process.stdout.write(
    JSON.stringify({
      status: 'pass',
      summary:
        'The #3137 revisions of project-session-3025, sandbox-capability-3124 and ' +
        'session-operation-surfaces-3089 ' + REVIEWED_SHA +
        ' are source-verified and published unchanged at ' + publishedSha,
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
          value: 'the pinned prototype revisions or their public Pages tree could not be matched',
        },
      ],
    }) + '\n',
  );
  process.exitCode = 1;
});
