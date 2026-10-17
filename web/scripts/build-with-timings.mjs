#!/usr/bin/env node
// #1876 SC-07: measure the three existing Web build stages independently.
// This is telemetry, never evidence that Quality/E2E/Acceptance passed.
// Keep the same build order, inherited environment, working directory,
// stdout/stderr, and fail-fast behavior as:
//   tsc && vite build && node scripts/copy-font-licenses.mjs
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const executable = (name) => process.platform === 'win32' ? name + '.cmd' : name;
const stages = [
  { id: 'typescript', command: executable('tsc'), args: [] },
  { id: 'vite', command: executable('vite'), args: ['build'] },
  { id: 'font_licenses', command: process.execPath, args: ['scripts/copy-font-licenses.mjs'] },
];
const sha = /^(?:[a-f0-9]{40})$/.test(process.env.NESSION_TARGET_SHA ?? '')
  ? process.env.NESSION_TARGET_SHA
  : (/^(?:[a-f0-9]{40})$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null);
const results = [];
const start = performance.now();
let failure = 0;

for (const stage of stages) {
  const at = performance.now();
  const child = spawnSync(stage.command, stage.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  const elapsed = Math.max(0, Math.round(performance.now() - at));
  const status = child.error ? 'error' : child.status === 0 ? 'success' : 'failure';
  results.push({ stage: stage.id, duration_ms: elapsed, status });
  console.log('WEB_BUILD_STAGE_V1 ' + JSON.stringify({
    schema_version: 1,
    target_sha: sha,
    stage: stage.id,
    duration_ms: elapsed,
    status,
  }));
  if (status !== 'success') {
    if (child.error) console.error('Web build ' + stage.id + ': ' + child.error.message);
    if (child.signal) console.error('Web build ' + stage.id + ' terminated by ' + child.signal);
    failure = Number.isInteger(child.status) && child.status > 0 ? child.status : 1;
    break;
  }
}
const summary = {
  schema_version: 1,
  kind: 'web_build_stage_timings',
  target_sha: sha,
  total_duration_ms: Math.max(0, Math.round(performance.now() - start)),
  stages: results,
  status: failure === 0 && results.length === stages.length ? 'Pass' : 'Fail',
};
console.log('WEB_BUILD_TIMINGS_V1 ' + JSON.stringify(summary));
if (failure) process.exitCode = failure;
