'use strict';
// #2519 SC-03: authenticated main-owned event-driven prototype publication.
// A live source push triggered a read-only signal and then a trusted Pages
// workflow_run. Validate the published HTTPS source SHA, new HTML HTTP 200,
// and the two real public GitHub Actions runs; do not assert Pass from code.
const { run, targetSha, checked } = require('../../../shared/control-mode-cases.cjs');
const { execFileSync } = require('node:child_process');

const HOST = 'https://bestnathan.github.io/nession';
const REPO = 'BestNathan/nession';
const EXPECTED_PROTOTYPE_SHA = 'b929fe89321b4bcc74d76e889f5c56c359a274cf';
const TRUSTED_MERGE_SHA = '2c90a55508c1e2a886fb88ce1e4a117bcfc1d4bb';
const SIGNAL_RUN_ID = 40534958867;
const PAGES_RUN_ID = 40534992571;
const SLUG = 'agent-process-discovery-2514';

function get(url) {
  if (!url.startsWith(HOST + '/') && !url.startsWith('https://api.github.com/repos/' + REPO + '/actions/runs/')) {
    throw new Error('refusing unexpected verifier origin');
  }
  return checked('curl', [
    '--fail', '--silent', '--show-error', '--location', '--connect-timeout', '10',
    '--max-time', '25', '--retry', '2', '--retry-delay', '1',
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'Cache-Control: no-cache',
    url,
  ], 90000).trim();
}
function githubRun(id) {
  const value = JSON.parse(get('https://api.github.com/repos/' + REPO + '/actions/runs/' + id));
  if (value.id !== id || value.repository?.full_name !== REPO || value.status !== 'completed' || value.conclusion !== 'success') {
    throw new Error('expected successful authenticated GitHub run #' + id);
  }
  return value;
}
run(({ evidence }) => {
  const target = targetSha();
  // The trusted publisher implementation under test must be an ancestor of
  // the merged main acceptance SHA; PR/synthetic source trees do not qualify.
  checked('git', ['merge-base', '--is-ancestor', TRUSTED_MERGE_SHA, target], 12000);

  const signal = githubRun(SIGNAL_RUN_ID);
  const pages = githubRun(PAGES_RUN_ID);
  if (signal.name !== 'Prototype / Change Signal' || signal.event !== 'push' ||
      signal.head_branch !== 'prototype' || signal.head_sha !== EXPECTED_PROTOTYPE_SHA) {
    throw new Error('producer is not the pinned read-only prototype push');
  }
  if (pages.name !== 'Deploy / Public Pages' || pages.event !== 'workflow_run' ||
      pages.head_branch !== 'main' || pages.head_sha !== TRUSTED_MERGE_SHA) {
    throw new Error('consumer is not the trusted merged-main workflow_run');
  }
  if (Date.parse(pages.created_at) < Date.parse(signal.updated_at)) {
    throw new Error('Pages consumer was not created after the source signal');
  }

  const manifest = JSON.parse(get(HOST + '/prototypes/manifest.json?revision=' + EXPECTED_PROTOTYPE_SHA));
  if (manifest.schema_version !== 1 ||
      manifest.source?.branch !== 'prototype' ||
      manifest.source?.sha !== EXPECTED_PROTOTYPE_SHA ||
      !Array.isArray(manifest.entries)) {
    throw new Error('public HTTPS manifest does not attest the expected prototype source');
  }
  const found = manifest.entries.find(entry => entry.slug === SLUG);
  if (!found || !String(found.source).startsWith(
    'https://github.com/' + REPO + '/blob/' + EXPECTED_PROTOTYPE_SHA + '/' + SLUG
  )) {
    throw new Error('new Agent process prototype missing or not pinned in public manifest');
  }

  // curl --fail enforces HTTP 200/2xx for the *new* preview, independently of
  // the historical fixed-cols detail path checked by the Pages publisher.
  const html = get(HOST + '/prototypes/' + SLUG + '/index.html?revision=' + EXPECTED_PROTOTYPE_SHA);
  if (!html.includes('id="scenario"') || !html.includes('id="stage"') ||
      !html.includes('agent-process-discovery-2514') || !html.includes('View source')) {
    throw new Error('public new prototype HTML is missing the expected interactive mock or source link');
  }
  evidence.push(
    { type: 'runtime', value: 'GitHub Actions source push run ' + SIGNAL_RUN_ID + ' at ' +
      EXPECTED_PROTOTYPE_SHA + ' succeeded; main workflow_run consumer ' + PAGES_RUN_ID +
      ' at ' + TRUSTED_MERGE_SHA + ' succeeded after it' },
    { type: 'runtime', value: 'anonymous HTTPS manifest confirmed prototype source ' +
      EXPECTED_PROTOTYPE_SHA + ' and Agent process slug ' + SLUG },
    { type: 'runtime', value: 'anonymous HTTPS GET of standalone ' + SLUG +
      '/index.html returned 2xx, with scenario selector, workspace stage and pinned source link' },
  );
  return 'The orphan prototype push triggered the trusted merged-main Pages workflow; ' +
    'the pinned public manifest and directly browsable Agent HTML both answer over HTTPS';
});
