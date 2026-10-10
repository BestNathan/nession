#!/usr/bin/env node
'use strict';

// Observation-only scenario. Nothing here assigns an Acceptance Pass:
// source-aligned SC evaluation and trusted orphan ingestion are separate owners.
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  startFullStackRuntime, allocateLoopbackPort,
} = require('../../runner/runtime/full-stack.js');

const {
  countMarkers, readTmux, sampleBrowser, redactObservation,
} = require('../../runner/collectors/terminal-observation.cjs');

const root = path.resolve(__dirname, '../../..');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const toJson = (data) => JSON.stringify(data, null, 2) + '\n';
const now = () => new Date().toISOString();
const maxSamples = 12;
const maxLines = 240;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function input(name) {
  const index = process.argv.indexOf('--' + name);
  return index < 0 ? null : process.argv[index + 1];
}
function ownedPath(name) {
  const suffix = randomBytes(6).toString('hex');
  return path.join(os.tmpdir(), 'nession-' + name + '-' + suffix);
}
function commandFor(session) {
  return 'seq 1 ' + maxLines + ' | sed "s/^/REPLAY_SCENARIO_' + session + '_/"';
}
function sessionSlug(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('unsafe Session slug');
  return name;
}
async function oneRun(runIndex, targetSha, output) {
  const { chromium, expect } = require('@playwright/test');
  const started = now();
  const [serverPort, agentPort, stalledProbePort, webPort] = await Promise.all(
    Array.from({ length: 4 }, () => allocateLoopbackPort()));
  const home = ownedPath('scenario-home');
  const tmuxDir = ownedPath('scenario-tmux');
  const socket = path.join(tmuxDir, 'tmux.sock');
  const session = sessionSlug('scenario_' + runIndex + '_' + randomBytes(4).toString('hex'));
  const marker = 'REPLAY_SCENARIO_' + session + '_';
  const observations = [];
  let runtime = null;
  let browser = null;
  let status = 'Error';
  let error = null;
  let created = false;
  const add = (item) => {
    if (observations.length >= 2 * maxSamples) throw new Error('observation bound exceeded');
    observations.push(redactObservation(item));
  };
  try {
    runtime = await startFullStackRuntime({
      repoRoot: root, targetSha, profile: 'scenario-terminal-replay',
      home, tmuxSocket: socket, serverPort, agentPort,
      stalledProbePort, webPort, cleanupHome: true,
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(runtime.base_url + '/?token=e2e-test-token&server_url=' +
      encodeURIComponent('ws://127.0.0.1:' + serverPort + '/ws'));
    const create = page.getByTestId('create-session');
    await expect(create).toBeEnabled({ timeout: 60_000 });
    await create.click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await modal.locator('#name').fill(session);
    await modal.getByRole('button', { name: 'Create' }).click();
    const attach = page.getByRole('dialog').filter({ hasText: 'Attach' });
    await expect(attach).toBeVisible({ timeout: 15_000 });
    await attach.getByRole('button', { name: /^Relay\b/ }).click();
    await attach.getByRole('button', { name: 'Attach' }).click();
    await expect(attach).not.toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30_000 });
    await page.evaluate((command) => {
      const term = document.querySelector('.xterm')?.parentElement?.xtermInstance;
      if (!term) throw new Error('terminal instance missing before input');
      term.input(command + '\n', true);
    }, commandFor(session));
    created = true;
    await sleep(700);
    add({
      at: now(), stage: 'before-reload', browser: await sampleBrowser(page, marker),
      backend: readTmux(socket, session, marker),
    });
    await page.reload();
    for (let i = 0; i < maxSamples; i += 1) {
      await sleep(i === 0 ? 100 : 450);
      add({
        at: now(), stage: 'after-reload', browser: await sampleBrowser(page, marker),
        backend: readTmux(socket, session, marker),
      });
      if (observations.at(-1).browser.marker_count >= maxLines) break;
    }
    status = 'Completed';
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (runtime) await runtime.stop().catch((caught) => {
      status = 'Error';
      error = 'teardown: ' + String(caught);
    });
  }
  return {
    schema_version: 1,
    kind: 'e2e_scenario_observation',
    scenario: 'terminal-attach-resume',
    target_sha: targetSha,
    scenario_revision: targetSha,
    run_id: Number(process.env.GITHUB_RUN_ID ?? 0) || null,
    run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 0) || null,
    run_index: runIndex,
    started_at: started,
    finished_at: now(),
    status,
    evaluation: null,
    error,
    config: { generated_lines: maxLines, samples_max: maxSamples, transport: 'Relay', reload: true },
    config_sha256: sha(toJson({ lines: maxLines, samples: maxSamples, transport: 'Relay', reload: true })),
    observation_count: observations.length,
    session_created: created,
    observations,
    evidence_scope: 'bounded counters, digests and wallclock timestamps; no raw terminal or secret data',
    evidence_path: output || null,
  };
}
function selfTest() {
  assert.equal(countMarkers('a_1 a_2 a_1', 'a_'), 3);
  assert.throws(() => sessionSlug('unsafe/$x'), /unsafe/);
  const safe = redactObservation({ at: now(), stage: 'after-reload',
    browser: { mounted: true, marker_count: 1, viewport: null, cookie: 'TOKEN' },
    backend: { marker_count: 1, sha256: 'a'.repeat(64), bytes: 100, raw: 'PRIVATE' },
    secret: 'TOKEN',
  });
  assert.equal(safe.secret, undefined);
  assert.equal(safe.browser.cookie, undefined);
  assert.equal(safe.backend.raw, undefined);
  assert.throws(() => redactObservation({ ...safe, backend: { ...safe.backend, bytes: -1 } }),
    /invalid or unbounded/);
  assert.equal(maxSamples < 16 && maxLines <= 500, true);
  console.log('terminal scenario observation self-test: 4 cases passed');
}
async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const expected = input('sha');
  if (!/^[a-f0-9]{40}$/.test(expected ?? '')) throw new Error('--sha must be exact 40-character SHA');
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (expected !== actual) throw new Error('scenario source checkout SHA mismatch');
  const repeat = Number(input('repeat') ?? 1);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) {
    throw new Error('--repeat must be 1..3; bound repeat count');
  }
  const out = input('output');
  if (!out) throw new Error('--output external path required; never write Run Records inside product source');
  const outputDir = path.resolve(out);
  if (outputDir.startsWith(root + path.sep)) throw new Error('Scenario records must not be written to product worktree');
  fs.mkdirSync(outputDir, { recursive: true });
  let failed = false;
  for (let i = 1; i <= repeat; i += 1) {
    const record = await oneRun(i, expected, outputDir);
    const file = path.join(outputDir, 'scenario-' + process.pid + '-' + i + '.json');
    fs.writeFileSync(file, toJson(record));
    console.log(JSON.stringify({ file, status: record.status, observations: record.observation_count,
      sha: record.target_sha, evaluation: record.evaluation }));
    if (record.status !== 'Completed') failed = true;
  }
  if (failed) process.exitCode = 2;
}
main().catch((error) => { console.error('Scenario Error: ' + error.message); process.exitCode = 2; });
