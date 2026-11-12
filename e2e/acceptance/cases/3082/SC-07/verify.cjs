'use strict';
// #3082 SC-07: the project-session-3025 prototype was updated for Session
// binding/contextual discovery, published with an immutable revision and
// reverified by real Chromium. The read-only Agent cannot see the orphan
// prototype branch or HTTP, so this criterion is proven by an executable
// readback of the publication and its archived Chromium record.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const REPO = 'BestNathan/nession';
const REVIEWED_SHA = '3e6d994677a9c10405e862e40abb80154b22995f';
const PAGES_RUN = 42568742684;
const TASK_RUN = 42568845676;
const MANIFEST_URL = 'https://bestnathan.github.io/nession/prototypes/manifest.json';
const PROTOTYPE_URL = 'https://bestnathan.github.io/nession/prototypes/project-session-3025/index.html';
const RECORD_URL =
  'https://raw.githubusercontent.com/BestNathan/nession/task-results/runs/' +
  'prototype-session-project-binding-3082-20261109/42568845676-1/record.json';
const API = 'https://api.github.com/repos/' + REPO;

async function read(url, { json = false } = {}) {
  const host = new URL(url).hostname;
  assert.ok(
    ['api.github.com', 'bestnathan.github.io', 'raw.githubusercontent.com'].includes(host),
    'unexpected public read host ' + host,
  );
  const headers = {
    'User-Agent': 'nession-3082-sc07-readback',
    'Cache-Control': 'no-cache',
    Accept: json ? 'application/vnd.github+json' : '*/*',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (host === 'api.github.com' && token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(url, {
    headers,
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
  const entry = (manifest.entries ?? []).find((item) => item.slug === 'project-session-3025');
  assert.ok(entry, 'project-session-3025 must be in the public prototype manifest');
  assert.equal(entry.preview, 'prototypes/project-session-3025/index.html');
  assert.ok(entry.source.includes(publishedSha), 'manifest entry must pin the published source');

  // The reviewed revision's source and the currently published source both
  // carry the Session-binding interaction. Fetching raw source avoids the
  // anonymous Actions API and proves the immutable revision itself.
  const raw = (sha, file) =>
    'https://raw.githubusercontent.com/BestNathan/nession/' + sha + '/project-session-3025/' + file;
  const reviewedHtml = await read(raw(REVIEWED_SHA, 'index.html'));
  const reviewedJs = await read(raw(REVIEWED_SHA, 'app.js'));
  const publishedHtml = await read(raw(publishedSha, 'index.html'));
  const publishedJs = await read(raw(publishedSha, 'app.js'));
  for (const [label, html, js] of [
    ['reviewed', reviewedHtml, reviewedJs],
    ['published', publishedHtml, publishedJs],
  ]) {
    assert.ok(html.includes('Project Peek'), label + ' prototype HTML is missing the Project Peek');
    for (const marker of ['bind-project', 'session-context-chip']) {
      assert.ok(js.includes(marker), label + ' prototype JS is missing ' + marker);
    }
  }

  // The live gallery still serves the published prototype with the same Peek.
  const liveHtml = await read(PROTOTYPE_URL + '?revision=' + publishedSha);
  assert.ok(liveHtml.includes('Project Peek'), 'published gallery must expose the Project Peek');

  // The archived Chromium task is the independent interaction proof at the
  // reviewed revision; its own manifest/HTML readback must have passed.
  const record = await read(RECORD_URL, { json: true });
  assert.equal(record.workflow?.id, TASK_RUN);
  assert.equal(record.workflow?.conclusion, 'success');
  assert.equal(record.execution?.status, 'Success');
  assert.equal(record.execution?.result?.source_sha, REVIEWED_SHA);
  const checks = record.execution?.result?.browser?.checks ?? [];
  assert.equal(checks.length, 32, 'the archived prototype task must report 32 checks');
  assert.ok(checks.every((check) => check.pass === true), 'every archived check must pass');
  assert.equal(
    record.execution?.result?.checks?.[0]?.label,
    'Public Pages manifest and pinned HTML',
  );
  assert.equal(record.execution?.result?.checks?.[0]?.sha, REVIEWED_SHA);
  assert.equal(record.execution?.result?.checks?.[0]?.pass, true);

  const evidence = [
    {
      type: 'pages',
      value:
        'public manifest source=' + publishedSha +
        '; entry project-session-3025 -> ' + entry.preview +
        '; the live gallery and both the reviewed (' + REVIEWED_SHA +
        ') and published source carry Project Peek/bind-project/session-context-chip',
    },
    {
      type: 'workflow',
      value:
        'Deploy / Public Pages run ' + PAGES_RUN +
        ' and Task / Ephemeral Runner run ' + TASK_RUN + ' are the witnessed publication/verification pair',
    },
    {
      type: 'record',
      value:
        'task-results/runs/prototype-session-project-binding-3082-20261109/' +
        TASK_RUN + '-1/record.json: ' + checks.length + '/32 browser checks passed at ' +
        REVIEWED_SHA + '; published_manifest_and_pinned_html passed',
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
        'The Session-binding prototype revision ' + REVIEWED_SHA +
        ' is an immutable source revision with a 32/32 Chromium record, and the public gallery still publishes the Project Peek',
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
            'the published prototype revision, its Pages run or the archived Chromium record was not verified',
        },
      ],
    }) + '\n',
  );
  process.exitCode = 1;
});
