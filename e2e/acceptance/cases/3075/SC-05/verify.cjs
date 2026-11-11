'use strict';
// #3075 SC-05: the review prototype is issue-linked, its immutable source is
// version-pinned, and the public Pages manifest/pages publish exactly that
// reviewed tree. The mock-vs-production boundary must be stated by the source
// itself; browser interaction evidence is recorded separately by the sibling
// browser verifier, not claimed here.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const REPO = 'BestNathan/nession';
const SLUG = 'sidebar-navigation-rail-3075';
const REVIEWED_SHA = 'df9021313d7db7169d0ca11c47939680b012fa8b';
const MANIFEST_URL = 'https://bestnathan.github.io/nession/prototypes/manifest.json';
const PROTOTYPE_URL = 'https://bestnathan.github.io/nession/prototypes/' + SLUG + '/index.html';

async function read(url, { json = false } = {}) {
  const host = new URL(url).hostname;
  assert.ok(
    ['bestnathan.github.io', 'raw.githubusercontent.com'].includes(host),
    'unexpected public read host ' + host,
  );
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'nession-3075-sc05-readback',
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
  assert.ok(entry, SLUG + ' must be in the public prototype manifest');
  assert.equal(entry.preview, 'prototypes/' + SLUG + '/index.html');
  assert.ok(entry.source.includes(publishedSha), 'manifest entry must pin the published source');

  // The reviewed revision and the currently published source must carry the
  // same prototype tree. The published manifest pins the branch head, which is
  // a descendant of the reviewed commit; equality of this directory is what
  // makes the live preview the reviewed design rather than a later edit.
  const raw = (revision, file) =>
    'https://raw.githubusercontent.com/' + REPO + '/' + revision + '/' + SLUG + '/' + file;
  const reviewedHtml = await read(raw(REVIEWED_SHA, 'index.html'));
  const reviewedReadme = await read(raw(REVIEWED_SHA, 'README.md'));
  const publishedHtml = await read(raw(publishedSha, 'index.html'));
  const publishedReadme = await read(raw(publishedSha, 'README.md'));
  assert.equal(publishedHtml, reviewedHtml, 'published HTML must equal the reviewed revision');
  assert.equal(publishedReadme, reviewedReadme, 'published README must equal the reviewed revision');

  // The source names the owning Issue and the design ancestry, and states the
  // mock boundary instead of implying production proof.
  assert.ok(reviewedReadme.includes('#3075'), 'README must link the owning Issue');
  assert.ok(reviewedReadme.includes('#2851'), 'README must state the #2851 ancestry');
  assert.ok(
    /supersed/i.test(reviewedReadme),
    'README must state that the 0px collapse is superseded',
  );
  assert.ok(/Limitations/i.test(reviewedReadme), 'README must state fidelity limitations');
  assert.ok(
    /not proof of production/i.test(reviewedReadme),
    'README must separate mock evidence from production proof',
  );
  for (const marker of ['id="rail"', 'data-action="expand"', 'data-action="collapse"']) {
    assert.ok(reviewedHtml.includes(marker), 'reviewed HTML is missing ' + marker);
  }

  // The live public page is the same prototype and names the published source.
  const liveHtml = await read(PROTOTYPE_URL);
  assert.ok(liveHtml.includes('id="rail"'), 'published page is the rail prototype');
  assert.ok(
    liveHtml.includes(publishedSha),
    'published page must name the published immutable source SHA',
  );

  const evidence = [
    {
      type: 'pages',
      value:
        'public manifest source=' + publishedSha + '; entry ' + SLUG + ' -> ' + entry.preview +
        '; the live page names that source SHA',
    },
    {
      type: 'source',
      value:
        REVIEWED_SHA + '/sidebar-navigation-rail-3075/{index.html,README.md} equals the ' +
        'published tree at ' + publishedSha + '; README links #3075/#2851, states ' +
        'supersession, limitations and the non-production mock boundary',
    },
    {
      type: 'runtime',
      value: 'Acceptance target SHA ' + sha + '; reviewed prototype commit ' + REVIEWED_SHA +
        '; published source revision ' + publishedSha,
    },
  ];
  process.stdout.write(
    JSON.stringify({
      status: 'pass',
      summary:
        'The #3075 rail prototype revision ' + REVIEWED_SHA +
        ' is issue-linked, immutable and published unchanged at ' + publishedSha +
        '; its mock boundary is stated in the source',
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
            'the pinned prototype source or its public Pages manifest/page could not be matched',
        },
      ],
    }) + '\n',
  );
  process.exitCode = 1;
});
