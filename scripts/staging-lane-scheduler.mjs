#!/usr/bin/env node
// Owner: #2323 SC-10. Compose the trusted lane receipts, Git ancestry and the
// pure admission policy into a scheduled decision. This module never reads a
// cluster or registry; the trusted workflow supplies the store records and an
// exact pinned Main SHA.
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { latestDeploymentBinding } from './deployment-binding-lookup.mjs';
import { config, countAncestry, stagingLaneAdmission } from './e2e-regression-policy.mjs';
import { enrichReceipt } from './deployment-attestation-ingest.mjs';

// Bounded, single-line admission receipt for the trusted Acceptance collector.
// The harness never reads artifacts or step summaries; this line is the lane
// identity (environment, deployed SHA, ahead/behind, due/admit decision) it
// can attest. #2323 SC-02/SC-10/SC-11 need it in ci_evidence.
export const STAGING_LANE_ADMISSION_LOG_PREFIX = 'STAGING_LANE_ADMISSION_V1 ';
const SHA = /^[a-f0-9]{40}$/;
const LANE = /^[a-z][a-z0-9-]{0,62}$/;
const DECISIONS = new Set([
  'ADMIT', 'NOT_DUE', 'SKIPPED_NOT_AHEAD', 'STALE_ATTESTATION',
  'FULL_IN_FLIGHT', 'INDETERMINATE', 'NOT_READY',
]);

// Validate the bounded receipt itself, independently of the plan that built
// it: the Acceptance collector parses this back from a job log.
export function validateAdmissionReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('staging lane admission receipt must be an object');
  }
  if (receipt.schema_version !== 1 || receipt.kind !== 'staging_lane_admission_receipt') {
    throw new Error('invalid staging lane admission receipt kind');
  }
  const mainSha = String(receipt.main_sha ?? '');
  if (!SHA.test(mainSha)) throw new Error('admission receipt requires an exact Main SHA');
  const now = String(receipt.now ?? '');
  if (!Number.isFinite(Date.parse(now))) throw new Error('admission receipt requires a valid timestamp');
  if (!Array.isArray(receipt.lanes) || receipt.lanes.length === 0) {
    throw new Error('admission receipt requires at least one lane');
  }
  const seen = new Set();
  const lanes = receipt.lanes.map((lane) => {
    const environment = String(lane?.environment_id ?? '');
    if (!LANE.test(environment) || seen.has(environment)) {
      throw new Error('invalid or duplicate admission lane ' + environment);
    }
    seen.add(environment);
    if (!DECISIONS.has(lane?.decision)) {
      throw new Error('invalid admission decision for ' + environment);
    }
    const deployed = String(lane?.deployed_source_sha ?? '');
    if (!SHA.test(deployed)) {
      throw new Error('admission receipt requires the deployed SHA for ' + environment);
    }
    const entry = {
      environment_id: environment,
      decision: lane.decision,
      deployed_source_sha: deployed,
    };
    if (lane.ahead != null) {
      if (!Number.isSafeInteger(lane.ahead)) throw new Error('invalid ahead count for ' + environment);
      entry.ahead = lane.ahead;
    }
    if (lane.behind != null) {
      if (!Number.isSafeInteger(lane.behind)) throw new Error('invalid behind count for ' + environment);
      entry.behind = lane.behind;
    }
    if (lane.next_due_at != null) {
      if (!Number.isFinite(Date.parse(lane.next_due_at))) {
        throw new Error('invalid next-due timestamp for ' + environment);
      }
      entry.next_due_at = String(lane.next_due_at);
    }
    if (lane.reason != null) {
      const reason = String(lane.reason);
      if (!reason || /[\r\n]/.test(reason)) throw new Error('invalid reason for ' + environment);
      entry.reason = reason;
    }
    return entry;
  });
  const admitted = Array.isArray(receipt.admitted) ? receipt.admitted.map(String) : [];
  if (new Set(admitted).size !== admitted.length ||
      admitted.some((environment) => !seen.has(environment))) {
    throw new Error('admitted lane is missing from the admission receipt');
  }
  return Object.freeze({
    schema_version: 1,
    kind: 'staging_lane_admission_receipt',
    main_sha: mainSha,
    now,
    admitted: Object.freeze(admitted),
    lanes: Object.freeze(lanes),
  });
}

export function admissionReceipt(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('admission plan must be an object');
  }
  const bindings = new Map((plan.bindings ?? []).map((entry) => [entry.environment_id, entry]));
  const lanes = (Array.isArray(plan.lanes) ? plan.lanes : []).map((lane) => ({
    environment_id: lane?.environment_id,
    decision: lane?.decision,
    deployed_source_sha: bindings.get(lane?.environment_id)?.deployed_source_sha,
    ...(Number.isSafeInteger(lane?.ahead) ? { ahead: lane.ahead } : {}),
    ...(Number.isSafeInteger(lane?.behind) ? { behind: lane.behind } : {}),
    ...(lane?.next_due_at != null ? { next_due_at: lane.next_due_at } : {}),
    ...(lane?.reason ? { reason: lane.reason } : {}),
  }));
  return validateAdmissionReceipt({
    schema_version: 1,
    kind: 'staging_lane_admission_receipt',
    main_sha: plan.main_sha,
    now: plan.now,
    admitted: Array.isArray(plan.admitted) ? plan.admitted : [],
    lanes,
  });
}

export function parseAdmissionReceipt(text) {
  const lines = String(text ?? '').split(/\r?\n/)
    .filter((line) => line.includes(STAGING_LANE_ADMISSION_LOG_PREFIX));
  if (lines.length !== 1) throw new Error('missing or ambiguous staging lane admission receipt');
  const line = lines[0];
  const raw = line
    .slice(line.indexOf(STAGING_LANE_ADMISSION_LOG_PREFIX) + STAGING_LANE_ADMISSION_LOG_PREFIX.length)
    .replace(/\u001b\[[0-9;]*m/g, '');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid staging lane admission receipt JSON');
  }
  return validateAdmissionReceipt(parsed);
}

export function formatAdmissionReceipt(plan) {
  return STAGING_LANE_ADMISSION_LOG_PREFIX + JSON.stringify(admissionReceipt(plan));
}

export function planLaneAdmission({
  now, mainSha, lanes, records, lastAdmitted = {}, inFlight = {},
  desiredShas = {}, cfg = config(process.env), exec,
}) {
  if (!Array.isArray(lanes) || lanes.length === 0) throw new Error('at least one lane is required');
  const laneEntries = [];
  const ancestry = {};
  for (const environmentId of lanes) {
    const binding = latestDeploymentBinding({ environmentId, records });
    laneEntries.push({
      environment_id: environmentId,
      deployed_source_sha: binding.source_sha,
      attested: true,
      ...(desiredShas[environmentId] ? { desired_sha: desiredShas[environmentId] } : {}),
    });
    ancestry[environmentId] = countAncestry(mainSha, binding.source_sha, exec);
  }
  const admission = stagingLaneAdmission({
    now, mainSha, lanes: laneEntries, cfg, lastAdmitted, inFlight, ancestry,
  });
  const admittedAt = { ...lastAdmitted };
  for (const lane of admission.lanes) {
    if (lane.decision === 'ADMIT') admittedAt[lane.environment_id] = admission.now;
  }
  const admittedShas = {};
  for (const lane of admission.lanes) {
    if (lane.decision !== 'ADMIT') continue;
    admittedShas[lane.environment_id] = laneEntries
      .find((entry) => entry.environment_id === lane.environment_id).deployed_source_sha;
  }
  return {
    ...admission,
    bindings: laneEntries,
    admitted_shas: admittedShas,
    admitted_at: admittedAt,
  };
}

function selfTest() {
  const main = 'c'.repeat(40);
  const stagingSha = 'a'.repeat(40);
  const staging01Sha = 'b'.repeat(40);
  const makeRecord = (environment, sourceSha, runId) => {
    const receipt = {
      schema_version: 1, kind: 'nession_deployment_attestation', status: 'Attested',
      environment_id: environment, namespace: 'nession-' + environment,
      cluster_context: 'ci', gitops_revision: 'f'.repeat(40),
      observed_at: '2026-10-25T01:00:00Z', source_sha: sourceSha,
      images: [
        { role: 'agent', declared_repository: 'ghcr.io/bestnathan/nession', repository: 'ghcr.io/bestnathan/nession', tag: 'agent-aaaaaaa', digest: 'sha256:' + '1'.repeat(64) },
        { role: 'server', declared_repository: 'ghcr.io/bestnathan/nession', repository: 'ghcr.io/bestnathan/nession', tag: 'server-aaaaaaa', digest: 'sha256:' + '2'.repeat(64) },
        { role: 'ui', declared_repository: 'ghcr.io/bestnathan/nession', repository: 'ghcr.io/bestnathan/nession', tag: 'ui-aaaaaaa', digest: 'sha256:' + '3'.repeat(64) },
      ],
      workloads: ['agent', 'server', 'ui'].map((role, index) => ({
        role, name: 'nession-' + role, namespace: 'nession-' + environment,
        uid: 'uid-' + role, generation: 3, observed_generation: 3, ready: true,
        image: 'ghcr.io/bestnathan/nession:' + role + '-aaaaaaa',
        image_id: 'ghcr.io/bestnathan/nession@sha256:' + String(index + 1).repeat(64),
        declared_repository: 'ghcr.io/bestnathan/nession',
        repository: 'ghcr.io/bestnathan/nession',
        digest: 'sha256:' + String(index + 1).repeat(64),
      })),
    };
    return {
      path: 'runs/2026-10-25/' + runId + '-1/deployment/' + environment + '.json',
      record: enrichReceipt(receipt, {
        source: { repository: 'BestNathan/nession', run_id: runId, run_attempt: 1,
          workflow_id: 9, event: 'workflow_dispatch', head_sha: main, head_branch: 'main' },
        workflowUrl: 'https://github.com/BestNathan/nession/actions/runs/' + runId,
        recordPath: 'runs/2026-10-25/' + runId + '-1/deployment/' + environment + '.json',
      }),
    };
  };
  const records = [makeRecord('staging', stagingSha, 800), makeRecord('staging-01', staging01Sha, 801)];
  const exec = (_cmd, args) => {
    const range = args[2];
    if (range === main + '..' + stagingSha) return '3\n';
    if (range === stagingSha + '..' + main) return '0\n';
    if (range === main + '..' + staging01Sha) return '0\n';
    if (range === staging01Sha + '..' + main) return '1\n';
    throw new Error('unexpected ancestry range ' + range);
  };
  const decision = planLaneAdmission({
    now: '2026-10-25T04:00:00Z', mainSha: main,
    lanes: ['staging', 'staging-01'], records,
    cfg: { staging: 2, main: 12, lanes: { 'staging-01': 6 } }, exec,
  });
  assert.deepEqual(decision.admitted, ['staging']);
  assert.equal(decision.lanes[1].decision, 'SKIPPED_NOT_AHEAD');
  assert.equal(decision.admitted_shas.staging, stagingSha);
  assert.equal(decision.admitted_at.staging, '2026-10-25T04:00:00.000Z');
  assert.equal(decision.admitted_at['staging-01'], undefined);

  const notDue = planLaneAdmission({
    now: '2026-10-25T04:00:00Z', mainSha: main,
    lanes: ['staging'], records,
    cfg: { staging: 2, main: 12, lanes: {} },
    lastAdmitted: { staging: '2026-10-25T03:30:00Z' }, exec,
  });
  assert.deepEqual(notDue.admitted, []);
  assert.equal(notDue.lanes[0].decision, 'NOT_DUE');
  assert.equal(notDue.admitted_at.staging, '2026-10-25T03:30:00Z');

  const stalePlan = planLaneAdmission({
    now: '2026-10-25T04:00:00Z', mainSha: main, lanes: ['staging'], records,
    desiredShas: { staging: 'd'.repeat(40) },
    cfg: { staging: 2, main: 12, lanes: {} }, exec,
  });
  assert.equal(stalePlan.lanes[0].decision, 'STALE_ATTESTATION');
  assert.deepEqual(stalePlan.admitted, []);
  assert.throws(() => planLaneAdmission({
    now: '2026-10-25T04:00:00Z', mainSha: main, lanes: ['staging-02'], records,
    cfg: { staging: 2, main: 12, lanes: {} }, exec,
  }), /no deployment attestation exists for environment staging-02/);

  // The bounded log receipt carries exactly the lane identity and decision the
  // trusted Acceptance collector attests.
  const receipt = admissionReceipt(decision);
  assert.equal(receipt.schema_version, 1);
  assert.equal(receipt.kind, 'staging_lane_admission_receipt');
  assert.equal(receipt.main_sha, main);
  assert.deepEqual(receipt.admitted, decision.admitted);
  assert.equal(receipt.lanes.length, 2);
  assert.deepEqual(receipt.lanes.map((lane) => lane.environment_id), ['staging', 'staging-01']);
  assert.equal(receipt.lanes[0].deployed_source_sha, stagingSha);
  assert.equal(
    formatAdmissionReceipt(decision).startsWith(STAGING_LANE_ADMISSION_LOG_PREFIX), true);
  assert.throws(() => admissionReceipt({ ...decision, main_sha: 'main' }), /exact Main SHA/);
  assert.throws(() => admissionReceipt({ ...decision, lanes: [{ environment_id: 'staging', decision: 'BOGUS' }] }),
    /invalid admission decision/);
  assert.throws(() => admissionReceipt({ ...decision, admitted: ['staging-02'] }),
    /admitted lane is missing/);
  const line = formatAdmissionReceipt(decision);
  assert.deepEqual(parseAdmissionReceipt('step log\n' + line + '\nnext'), receipt);
  assert.deepEqual(parseAdmissionReceipt('\u001b[36;1m' + line + '\u001b[0m'), receipt);
  assert.throws(() => parseAdmissionReceipt('no receipt'), /missing or ambiguous/);
  assert.throws(() => parseAdmissionReceipt(line + '\n' + line), /missing or ambiguous/);
  assert.throws(() => parseAdmissionReceipt(STAGING_LANE_ADMISSION_LOG_PREFIX + '{'),
    /invalid staging lane admission receipt JSON/);
  assert.throws(() => parseAdmissionReceipt(STAGING_LANE_ADMISSION_LOG_PREFIX +
    JSON.stringify({ ...receipt, main_sha: 'main' })), /exact Main SHA/);

  console.log('staging lane scheduler: receipt -> ancestry -> admission fixture passed');
}

function main() {
  if (process.argv[2] === 'self-test') {
    selfTest();
    return;
  }
  if (process.argv[2] === 'plan') {
    const [lanesCsv, mainSha, recordsFile, previousFile, output] = process.argv.slice(3);
    if (!lanesCsv || !mainSha || !recordsFile || !output) {
      throw new Error('usage: plan LANES_CSV MAIN_SHA RECORDS_JSON PREVIOUS_JSON OUTPUT_JSON');
    }
    const lanes = lanesCsv.split(',').map((lane) => lane.trim()).filter(Boolean);
    const records = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
    const previous = previousFile && fs.existsSync(previousFile)
      ? JSON.parse(fs.readFileSync(previousFile, 'utf8'))
      : {};
    const desiredPath = process.env.DESIRED_SHAS_JSON ?? '';
    const desiredShas = desiredPath ? JSON.parse(fs.readFileSync(desiredPath, 'utf8')) : {};
    const result = planLaneAdmission({
      now: new Date().toISOString(), mainSha, lanes, records,
      lastAdmitted: previous.admitted_at ?? {}, desiredShas,
    });
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(JSON.stringify({
      admitted: result.admitted,
      lanes: result.lanes.map((lane) => ({
        environment_id: lane.environment_id,
        decision: lane.decision,
        next_due_at: lane.next_due_at ?? null,
      })),
    }) + '\n');
    process.stdout.write(formatAdmissionReceipt(result) + '\n');
    return;
  }
  throw new Error('usage: self-test | plan LANES_CSV MAIN_SHA RECORDS_JSON PREVIOUS_JSON OUTPUT_JSON');
}

if (process.argv[1]?.endsWith('staging-lane-scheduler.mjs')) {
  try {
    main();
  } catch (error) {
    console.error('staging-lane-scheduler: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  }
}
