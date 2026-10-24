#!/usr/bin/env node
// Owner: #2323. Main-owned pure scheduling and Staging ancestry admission.
// A branch ref is NOT a deployed-environment attestation; callers must supply
// independently authenticated source/digest identity (#1616) for remote Staging.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const SHA = /^[0-9a-f]{40}$/;
const LANE = /^[a-z][a-z0-9-]{0,62}$/;
export const DEFAULT_INTERVALS = Object.freeze({ staging: 2, main: 12 });

export function interval(value, fallback) {
  const raw = value == null || value === '' ? String(fallback) : String(value);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('invalid E2E interval: expected positive whole hours');
  const hours = Number(raw);
  if (!Number.isSafeInteger(hours) || hours > 168) {
    throw new Error('invalid E2E interval: must be in 1..168 hours');
  }
  return hours;
}

export function config(env = process.env) {
  const staging = interval(env.E2E_STAGING_INTERVAL_HOURS, DEFAULT_INTERVALS.staging);
  const main = interval(env.E2E_MAIN_INTERVAL_HOURS, DEFAULT_INTERVALS.main);
  const text = env.E2E_STAGING_LANE_INTERVALS_JSON || '{}';
  let obj;
  try { obj = JSON.parse(text); }
  catch { throw new Error('invalid E2E_STAGING_LANE_INTERVALS_JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('lane interval overrides must be an object');
  }
  const lanes = {};
  for (const [name, hours] of Object.entries(obj)) {
    if (!LANE.test(name) || typeof hours !== 'number') {
      throw new Error('invalid staging lane interval override');
    }
    lanes[name] = interval(hours, staging);
  }
  return { main, staging, lanes };
}

// Stateless UTC-hour admission for GitHub's fixed hourly schedule.
// GitHub does not support dynamic cron expressions from repository Variables.
// This function never means a run passed or was deployed successfully.
export function isDue(now, hours) {
  const parsed = new Date(now);
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid schedule timestamp');
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) throw new Error('invalid interval');
  return Math.floor(parsed.getTime() / 3600000) % hours === 0;
}

export function stagingEligibility({ ready, attested, mainSha, deployedSha, ahead, behind }) {
  if (ready !== true) return { decision: 'NOT_READY' };
  if (attested !== true || !SHA.test(mainSha || '') || !SHA.test(deployedSha || '')) {
    return { decision: 'INDETERMINATE', reason: 'deployed identity not authenticated' };
  }
  if (!Number.isSafeInteger(ahead) || ahead < 0 || !Number.isSafeInteger(behind) || behind < 0) {
    return { decision: 'INDETERMINATE', reason: 'ancestry cannot be proven' };
  }
  if (ahead === 0) return { decision: 'SKIPPED_NOT_AHEAD', ahead, behind };
  return { decision: 'ELIGIBLE', ahead, behind, diverged: behind > 0 };
}

export function countAncestry(mainSha, deployedSha, exec = execFileSync) {
  if (!SHA.test(mainSha) || !SHA.test(deployedSha)) throw new Error('untrusted source SHA');
  // Requires complete (non-shallow) Git history; failures cannot turn into skip/pass.
  const count = (range) => {
    const output = exec('git', ['rev-list', '--count', range], { encoding: 'utf8' }).trim();
    if (!/^[0-9]+$/.test(output)) throw new Error('invalid Git ancestry count');
    return Number(output);
  };
  return { ahead: count(mainSha + '..' + deployedSha), behind: count(deployedSha + '..' + mainSha) };
}

function selfTest() {
  assert.deepEqual(config({}), { staging: 2, main: 12, lanes: {} });
  assert.deepEqual(config({ E2E_STAGING_INTERVAL_HOURS: '3',
    E2E_MAIN_INTERVAL_HOURS: '24', E2E_STAGING_LANE_INTERVALS_JSON: '{"staging-01":6}' }),
  { staging: 3, main: 24, lanes: { 'staging-01': 6 } });
  for (const raw of ['-1', '0', '2.5', 'abc', '169', '01']) {
    assert.throws(() => interval(raw, 2));
  }
  assert.throws(() => config({ E2E_STAGING_LANE_INTERVALS_JSON: '[]' }));
  assert.throws(() => config({ E2E_STAGING_LANE_INTERVALS_JSON: '{"../../secret":2}' }));
  assert.equal(isDue('2026-10-24T00:07:00Z', 12), true);
  assert.equal(isDue('2026-10-24T12:07:00Z', 12), true);
  assert.equal(isDue('2026-10-24T10:07:00Z', 12), false);
  assert.equal(isDue('2026-10-24T10:07:00Z', 2), true);
  assert.equal(isDue('2026-10-24T11:07:00Z', 2), false);
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  const eligible = (data) => stagingEligibility({ ready: true, attested: true,
    mainSha: a, deployedSha: b, ...data });
  assert.equal(eligible({ ahead: 0, behind: 0 }).decision, 'SKIPPED_NOT_AHEAD');
  assert.equal(eligible({ ahead: 0, behind: 2 }).decision, 'SKIPPED_NOT_AHEAD');
  assert.deepEqual(eligible({ ahead: 3, behind: 1 }), {
    decision: 'ELIGIBLE', ahead: 3, behind: 1, diverged: true });
  assert.equal(eligible({ ahead: 2, behind: 0, attested: false }).decision, 'INDETERMINATE');
  assert.equal(eligible({ ahead: null, behind: 0 }).decision, 'INDETERMINATE');
  assert.deepEqual(countAncestry(a, b, (_, args) =>
    args[2] === a + '..' + b ? '4\n' : '2\n'), { ahead: 4, behind: 2 });
  assert.throws(() => countAncestry('main', b));
  console.log('e2e-regression-policy self-test: PASS');
}

function main() {
  const action = process.argv[2];
  if (action === 'self-test') return selfTest();
  const cfg = config();
  if (action === 'admit-main') {
    const due = isDue(new Date(), cfg.main);
    const result = { decision: due ? 'ELIGIBLE' : 'NOT_DUE', interval_hours: cfg.main };
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT,
        'run=' + String(due) + '\ninterval_hours=' + cfg.main + '\n');
    }
    console.log(JSON.stringify(result));
    return;
  }
  if (action === 'staging-ancestry') {
    const [mainSha, deployedSha] = process.argv.slice(3);
    const counts = countAncestry(mainSha, deployedSha);
    console.log(JSON.stringify(stagingEligibility({
      ready: true, attested: false, mainSha, deployedSha, ...counts
    })));
    // Deliberately cannot attest a deployment solely from two supplied SHAs.
    return;
  }
  throw new Error('usage: self-test | admit-main | staging-ancestry');
}

try { main(); }
catch (error) { console.error('e2e-regression-policy: ' + error.message); process.exitCode = 2; }
