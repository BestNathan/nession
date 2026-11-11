'use strict';
// #3025 SC-06: the approved Project/Session prototype is pinned to an
// immutable source revision and independently readable from the public Pages
// publication. The read-only Acceptance Agent cannot see the orphan prototype
// branch or reach HTTP, so this criterion is proven by an executable readback
// (SCN-08: exact content + source SHA + publication readback) rather than a
// model claim about files it cannot access.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const REPO = 'BestNathan/nession';
const PROTOTYPE_SHA = 'c6a1b0fe5695712603b1fd36ed83b0ce5652d840';
const PAGES_RUN = 42501801927;
const TASK_RUN = 42501806352;
const MANIFEST_URL = 'https://bestnathan.github.io/nession/prototypes/manifest.json';
const HTML_URL =
  'https://bestnathan.github.io/nession/prototypes/project-session-3025/index.html?revision=' +
  PROTOTYPE_SHA;
const RECORD_URL =
  'https://raw.githubusercontent.com/BestNathan/nession/task-results/runs/' +
  'prototype-project-management-3025-20261109/42501806352-1/record.json';
const API = 'https://api.github.com/repos/' + REPO;

async function read(url, { json = false } = {}) {
  const host = new URL(url).hostname;
  assert.ok(
    ['api.github.com', 'bestnathan.github.io', 'raw.githubusercontent.com'].includes(host),
    'unexpected public read host ' + host,
  );
  const headers = {
    'User-Agent': 'nession-3025-sc06-readback',
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
  const [manifest, html, record, pagesRun, taskRun, commit] = await Promise.all([
    read(MANIFEST_URL, { json: true }),
    read(HTML_URL),
    read(RECORD_URL, { json: true }),
    read(API + '/actions/runs/' + PAGES_RUN, { json: true }),
    read(API + '/actions/runs/' + TASK_RUN, { json: true }),
    read(API + '/commits/' + PROTOTYPE_SHA, { json: true }),
  ]);

  // The public manifest is the publication authority: it pins the exact
  // prototype source revision the deployed gallery was built from.
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.source?.branch, 'prototype');
  assert.equal(manifest.source?.sha, PROTOTYPE_SHA);
  const entry = (manifest.entries ?? []).find((item) => item.slug === 'project-session-3025');
  assert.ok(entry, 'project-session-3025 must be in the public prototype manifest');
  assert.equal(entry.preview, 'prototypes/project-session-3025/index.html');
  assert.ok(entry.source.includes(PROTOTYPE_SHA), 'manifest entry must pin the source SHA');
  assert.ok(entry.assets >= 1, 'the published prototype must carry its assets');

  // The live HTML must be the pinned revision and carry the reviewed scenario
  // surfaces (Project detail, Existing and Managed/EROFS paths).
  assert.ok(html.includes(PROTOTYPE_SHA), 'published HTML must identify the pinned revision');
  for (const marker of ['ProjectDetail', 'Existing', 'Managed', 'EROFS']) {
    assert.ok(html.includes(marker), 'published HTML is missing ' + marker);
  }

  // The archived Chromium task observed the same pinned revision and 41
  // passing interaction checks, including the manifest/HTML readback.
  assert.equal(record.workflow?.id, TASK_RUN);
  assert.equal(record.workflow?.conclusion, 'success');
  assert.equal(record.execution?.status, 'Success');
  assert.equal(record.execution?.result?.source_sha, PROTOTYPE_SHA);
  const checks = record.execution?.result?.browser?.checks ?? [];
  assert.equal(checks.length, 41, 'the archived prototype task must report 41 checks');
  assert.ok(checks.every((check) => check.pass === true), 'every archived check must pass');
  assert.equal(record.execution?.result?.checks?.[0]?.name, 'published_manifest_and_pinned_html');
  assert.equal(record.execution?.result?.checks?.[0]?.pass, true);

  // Independent GitHub Run identity, not just the archived task's claim.
  assert.equal(pagesRun.id, PAGES_RUN);
  assert.equal(pagesRun.name, 'Deploy / Public Pages');
  assert.equal(pagesRun.event, 'workflow_run');
  assert.equal(pagesRun.status, 'completed');
  assert.equal(pagesRun.conclusion, 'success');
  assert.equal(taskRun.id, TASK_RUN);
  assert.equal(taskRun.status, 'completed');
  assert.equal(taskRun.conclusion, 'success');
  assert.equal(commit.sha, PROTOTYPE_SHA);

  const evidence = [
    {
      type: 'pages',
      value:
        'public manifest source=' + manifest.source.branch + '@' + manifest.source.sha +
        '; entry project-session-3025 -> ' + entry.preview + '; live HTML at revision ' +
        PROTOTYPE_SHA + ' returned HTTP 200 (' + Buffer.byteLength(html) + ' bytes) with ' +
        'ProjectDetail/Existing/Managed/EROFS markers',
    },
    {
      type: 'workflow',
      value:
        'Deploy / Public Pages run ' + PAGES_RUN + ' (' + pagesRun.event + ', ' +
        pagesRun.conclusion + '); Task / Ephemeral Runner run ' + TASK_RUN + ' (' +
        taskRun.conclusion + ')',
    },
    {
      type: 'record',
      value:
        'task-results/prototype-project-management-3025-20261109/42501806352-1/record.json: ' +
        checks.length + '/41 browser checks passed at ' + PROTOTYPE_SHA +
        '; published_manifest_and_pinned_html passed',
    },
    {
      type: 'runtime',
      value: 'Acceptance target SHA ' + sha + '; prototype commit ' + commit.sha + ' exists in ' + REPO,
    },
  ];
  process.stdout.write(
    JSON.stringify({
      status: 'pass',
      summary:
        'The approved #3025 prototype is pinned to ' + PROTOTYPE_SHA +
        ' and its public Pages HTML plus 41-check Chromium record were independently read back',
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
            'the pinned prototype revision, public Pages HTML or archived Chromium record was not verified',
        },
      ],
    }) + '\n',
  );
  process.exitCode = 1;
});
