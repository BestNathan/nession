'use strict';

// #2519 SC-03: Verify a *real* post-merge prototype push event triggered
// main-owned Pages publication, and that the current anonymous HTTPS site
// serves the same source revision plus the interactive #2514 HTML.
//
// Read-only network operations and exact GitHub Run IDs are pinned evidence;
// there is no simulated GitHub event, local publisher stand-in or Issue write.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = 'BestNathan/nession';
const BASE_URL = 'https://bestnathan.github.io/nession/';
const API = 'https://api.github.com/repos/' + REPO;
const WITNESS = Object.freeze({
  sourceSha: 'b929fe89321b4bcc74d76e889f5c56c359a274cf',
  signalRun: 40534958867,
  deployRun: 40534992571,
});
const SHA = /^[a-f0-9]{40}$/;
const root = path.resolve(__dirname, '../../../../..');

function ensureTarget() {
  const target = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA || '');
  assert.match(target, SHA, 'Acceptance requires an exact 40-char target SHA');
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(checkout, target, 'Case checkout must match the exact target SHA');
  return target;
}

async function get(url, asJson = true, useGithubAuth = false) {
  const headers = {
    'User-Agent': 'nession-source-aligned-acceptance-2519',
    'Accept': useGithubAuth ? 'application/vnd.github+json' : 'text/html, application/json',
    'Cache-Control': 'no-cache',
  };
  // Optional read-only GitHub token mitigates shared runner API rate limits.
  // It is only sent to the fixed api.github.com host and is never logged.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (useGithubAuth && token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, 'HTTP ' + response.status + ' fetching ' + new URL(url).pathname);
  return asJson ? response.json() : response.text();
}

async function run() {
  const target = ensureTarget();
  const source = fs.readFileSync(path.join(root, '.github/workflows/deploy-pages.yml'), 'utf8');
  for (const fragment of [
    "workflows: ['Prototype / Change Signal']",
    'types: [completed]',
    'branches: [prototype]',
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'prototype'",
    'github.event.workflow_run.head_repository.full_name == github.repository',
  ]) assert.ok(source.includes(fragment), 'Trusted main workflow no longer permits the guarded source signal');

  const [signal, publisher, gitRef] = await Promise.all([
    get(API + '/actions/runs/' + WITNESS.signalRun, true, true),
    get(API + '/actions/runs/' + WITNESS.deployRun, true, true),
    get(API + '/git/ref/heads/prototype', true, true),
  ]);

  assert.equal(signal.name, 'Prototype / Change Signal');
  assert.equal(signal.event, 'push');
  assert.equal(signal.head_branch, 'prototype');
  assert.equal(signal.head_repository.full_name, REPO);
  assert.equal(signal.status, 'completed');
  assert.equal(signal.conclusion, 'success');
  assert.equal(signal.head_sha, WITNESS.sourceSha);

  assert.equal(publisher.name, 'Deploy / Public Pages');
  assert.equal(publisher.event, 'workflow_run', 'Publisher must be caused by workflow_run, not schedule/main push');
  assert.equal(publisher.head_branch, 'main');
  assert.equal(publisher.status, 'completed');
  assert.equal(publisher.conclusion, 'success');
  assert.ok(new Date(publisher.created_at) > new Date(signal.created_at), 'Publisher must follow actual source push');
  assert.match(publisher.head_sha, SHA);
  execFileSync('git', ['merge-base', '--is-ancestor', publisher.head_sha, target], {cwd: root});

  assert.match(gitRef.object.sha, SHA);
  const currentSourceSha = gitRef.object.sha;
  // No green from an old branch commit after a later source update.
  const [manifest, preview] = await Promise.all([
    get(BASE_URL + 'prototypes/manifest.json?revision=' + currentSourceSha, true),
    get(BASE_URL + 'prototypes/agent-process-discovery-2514/index.html?revision=' + currentSourceSha, false),
  ]);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.source.branch, 'prototype');
  assert.equal(manifest.source.sha, currentSourceSha, 'Live manifest must match current prototype branch');
  const entry = manifest.entries.find(x => x.slug === 'agent-process-discovery-2514');
  assert.ok(entry, 'Public prototype manifest must contain Agent process discovery');
  assert.equal(entry.preview, 'prototypes/agent-process-discovery-2514/index.html');
  assert.equal(entry.source, 'https://github.com/' + REPO + '/blob/' + currentSourceSha +
    '/agent-process-discovery-2514/index.html');
  assert.ok(preview.includes('Agent Capability / Process Discovery'), 'Published HTML must be the interactive Agent mock');
  assert.ok(preview.includes('id="scenario"'), 'Four-state interactive HTML selector is missing');
  assert.ok(preview.includes('View source'), 'Pinned public source navigation missing');
  assert.ok(preview.includes(currentSourceSha), 'Decorated HTML must cite the exact source SHA');

  // A newer version may have been published by another valid prototype push;
  // still prove it descends from the actual source signal in this Case.
  if (currentSourceSha !== WITNESS.sourceSha) {
    const compare = await get(API + '/compare/' + WITNESS.sourceSha + '...' + currentSourceSha, true, true);
    assert.ok(compare.status === 'ahead' || compare.status === 'identical',
      'Current source does not descend from the audited workflow signal');
  }

  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'Prototype push emitted an unprivileged signal, triggered trusted main Pages, and served exact public HTML/manifest',
    evidence: [
      { type: 'runtime', value: 'source signal Run ' + WITNESS.signalRun + ': completed success, event=push, branch=prototype, sha=' + WITNESS.sourceSha },
      { type: 'runtime', value: 'trusted Pages Run ' + WITNESS.deployRun + ': completed success, event=workflow_run, main_sha=' + publisher.head_sha },
      { type: 'runtime', value: 'anonymous HTTPS manifest and #2514 interactive HTML matched prototype head ' + currentSourceSha +
        '; expected source link and 4-state scenario selector observed' },
      { type: 'runtime', value: 'Acceptance exact main target_sha=' + target + ', publisher main SHA was verified ancestor' },
    ],
  }) + '\n');
}
run().catch(error => {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error.message || error).slice(0, 2200),
    evidence: [{type: 'runtime', value: '#2519 post-merge source signal, trusted Pages Run, or anonymous HTTPS readback was not verified'}],
  }) + '\n');
  process.exitCode = 1;
});
