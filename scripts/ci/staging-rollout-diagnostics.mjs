#!/usr/bin/env node
// #3994: bounded, redacted, read-only Staging rollout triage. NOT an attestation.
// Never publish raw Kubernetes Pod/Event JSON, Events.message, env, logs or token strings.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ROLES = ['server', 'agent', 'ui'];
const NAME = /^nession-(server|agent|ui)-staging$/;
const POD_OWNER = /^nession-(server|agent|ui)-staging-[a-z0-9]+$/;
const DIGEST = /@(?<digest>sha256:[a-f0-9]{64})$/;
const SAFE_REASONS = new Set([
  'BackOff', 'CrashLoopBackOff', 'ContainerCannotRun', 'ContainersNotReady',
  'CreateContainerConfigError', 'CreateContainerError', 'Created',
  'ErrImagePull', 'Failed', 'FailedAttachVolume', 'FailedCreate',
  'FailedCreatePodSandBox', 'FailedMount', 'FailedScheduling',
  'FailedSync', 'FailedToRetrieveImagePullSecret', 'ImagePullBackOff',
  'InvalidImageName', 'Killing', 'OOMKilled', 'OOMKilling',
  'PodInitializing', 'Pulled', 'Pulling', 'RunContainerError',
  'Started', 'Unhealthy', 'Unschedulable',
  // Kubernetes Deployment conditions (not arbitrary controller or provider text).
  'MinimumReplicasAvailable', 'MinimumReplicasUnavailable',
  'NewReplicaSetAvailable', 'ProgressDeadlineExceeded',
  'ReplicaSetUpdated', 'ReplicaSetCreateError', 'FailedDelete',
  // Standard Pod / kubelet reasons. Preserve unknown reasons as "other".
  'PodReadyToStartContainers', 'ContainerCreating', 'Completed',
  'Error', 'Scheduled', 'SuccessfulCreate',
]);
function boundedInt(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : null;
}
function reason(value) {
  return typeof value === 'string'
    ? (SAFE_REASONS.has(value) ? value : 'other') : null;
}
function tag(value, role) {
  if (typeof value !== 'string') return null;
  const found = value.match(new RegExp('(?:^|:)(' + role + '-[a-f0-9]{7,40})$'));
  return found ? found[1] : null;
}
function digest(value) {
  return typeof value === 'string' ? (value.match(DIGEST)?.groups?.digest ?? null) : null;
}
function objects(value, max) {
  if (!Array.isArray(value?.items) || value.items.length > max) {
    throw Error('invalid or unbounded Kubernetes observation');
  }
  return value.items;
}
function status(value) {
  return value === 'True' || value === 'False' || value === 'Unknown' ? value : 'Unknown';
}
function phase(value) {
  return ['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown'].includes(value)
    ? value : 'Unknown';
}
function containerState(entry) {
  const state = entry?.state ?? {};
  const previous = entry?.lastState?.terminated;
  return {
    ready: entry?.ready === true,
    restart_count: boundedInt(entry?.restartCount),
    image_digest: digest(entry?.imageID),
    waiting_reason: reason(state.waiting?.reason),
    terminated_reason: reason(state.terminated?.reason),
    terminated_exit_code: boundedInt(state.terminated?.exitCode),
    previous_terminated_reason: reason(previous?.reason),
    previous_exit_code: boundedInt(previous?.exitCode),
  };
}
export function readback({deployments, pods, events = null, short}) {
  if (typeof short !== 'string' || !/^[a-f0-9]{7,40}$/.test(short)) {
    throw Error('invalid trusted source suffix');
  }
  const deploymentsOut = [];
  for (const entry of objects(deployments, 100)) {
    const name = entry?.metadata?.name;
    const matched = typeof name === 'string' ? name.match(NAME) : null;
    if (!matched || entry?.metadata?.namespace !== 'nession') continue;
    const role = matched[1];
    const containers = entry.spec?.template?.spec?.containers;
    const roleContainer = Array.isArray(containers) && containers.length === 1
      ? containers[0] : null;
    deploymentsOut.push({
      role, generation: boundedInt(entry.metadata?.generation),
      observed_generation: boundedInt(entry.status?.observedGeneration),
      desired: boundedInt(entry.spec?.replicas ?? 1),
      updated: boundedInt(entry.status?.updatedReplicas ?? 0),
      ready: boundedInt(entry.status?.readyReplicas ?? 0),
      available: boundedInt(entry.status?.availableReplicas ?? 0),
      image_tag: tag(roleContainer?.image, role),
      conditions: (entry.status?.conditions ?? []).slice(0, 10).map(c => ({
        type: ['Available', 'Progressing', 'ReplicaFailure'].includes(c?.type)
          ? c.type : 'other',
        status: status(c?.status), reason: reason(c?.reason),
      })),
    });
  }
  const podsOut = [];
  const podUids = new Map();
  for (const entry of objects(pods, 500)) {
    const owner = entry?.metadata?.ownerReferences?.find(o => o?.kind === 'ReplicaSet');
    const matched = typeof owner?.name === 'string' ? owner.name.match(POD_OWNER) : null;
    if (!matched || entry?.metadata?.namespace !== 'nession' ||
        entry?.metadata?.labels?.env !== 'staging') continue;
    const role = matched[1];
    if (typeof entry?.metadata?.uid === 'string') podUids.set(entry.metadata.uid, role);
    podsOut.push({
      role, phase: phase(entry.status?.phase),
      conditions: (entry.status?.conditions ?? []).slice(0, 10).map(c => ({
        type: ['Ready', 'ContainersReady', 'Initialized', 'PodScheduled'].includes(c?.type)
          ? c.type : 'other',
        status: status(c?.status), reason: reason(c?.reason),
      })),
      containers: (entry.status?.containerStatuses ?? []).slice(0, 10).map(containerState),
    });
  }
  const eventsOut = [];
  if (events !== null) {
    for (const entry of objects(events, 1000)) {
      const involved = entry?.involvedObject ?? entry?.regarding;
      if (involved?.kind !== 'Pod' || involved?.namespace !== 'nession') continue;
      const role = podUids.get(involved.uid);
      if (!role) continue;
      eventsOut.push({
        role,
        type: ['Warning', 'Normal'].includes(entry.type) ? entry.type : 'other',
        reason: reason(entry.reason),
        count: boundedInt(entry.count ?? 1),
      });
    }
  }
  return Object.freeze({
    schema: 'nession-staging-rollout-readback-v2',
    desired_sha: short,
    deployments: deploymentsOut,
    pod_status: podsOut,
    event_access: events === null ? 'not-authorized' : 'observed',
    pod_events: eventsOut.slice(-40),
    attestation: false,
  });
}
function selfTest() {
  const token = 'LEAK_ME_BEARER_ABC';
  const pod = {
    metadata: {namespace:'nession', uid:'pod1', labels:{env:'staging'},
      ownerReferences:[{kind:'ReplicaSet',name:'nession-server-staging-abc123'}]},
    status: {phase:'Running', conditions:[{type:'ContainersReady',status:'False',
      reason:'ContainersNotReady',message:token}],
      containerStatuses:[{ready:false,restartCount:4,imageID:'ghcr.example@sha256:'+'a'.repeat(64),
        state:{waiting:{reason:'CrashLoopBackOff',message:token}},
        lastState:{terminated:{reason:'OOMKilled',exitCode:137,message:token}}}]},
    spec:{containers:[{env:[{name:'TOKEN',value:token}]}]},
  };
  const d = {items:[{metadata:{name:'nession-server-staging',namespace:'nession',generation:3},
    spec:{replicas:1,template:{spec:{containers:[{image:'acr.example/nession:server-abcdef0'}]}}},
    status:{availableReplicas:0,observedGeneration:3,conditions:[{
      type:'Available',status:'False',reason:'MinimumReplicasUnavailable',message:token}]}}]};
  const p = {items:[pod,{...pod,metadata:{...pod.metadata,
    uid:'foreign',labels:{env:'staging-01'}}}]};
  const e = {items:[{involvedObject:{kind:'Pod',namespace:'nession',uid:'pod1'},
    type:'Warning',reason:'FailedMount',message:token,count:7},
    {involvedObject:{kind:'Pod',namespace:'nession',uid:'foreign'},
      type:'Warning',reason:'Failed',message:token}]};
  const actual = readback({deployments:d,pods:p,events:e,short:'abcdef0'});
  assert.equal(actual.deployments[0].available,0);
  assert.equal(actual.deployments[0].conditions[0].reason,'MinimumReplicasUnavailable');
  assert.equal(actual.pod_status.length,1);
  assert.equal(actual.pod_status[0].containers[0].previous_exit_code,137);
  assert.equal(actual.pod_status[0].containers[0].waiting_reason,'CrashLoopBackOff');
  assert.equal(actual.pod_events.length,1);
  assert.equal(actual.pod_events[0].reason,'FailedMount');
  assert.ok(!JSON.stringify(actual).includes(token));
  assert.ok(!JSON.stringify(actual).includes('acr.example'));
  const healthy = structuredClone(d);
  healthy.items[0].status.conditions[0].status = 'True';
  healthy.items[0].status.conditions[0].reason = 'MinimumReplicasAvailable';
  assert.equal(readback({deployments:healthy,pods:p,short:'abcdef0'})
    .deployments[0].conditions[0].reason,'MinimumReplicasAvailable');
  healthy.items[0].status.conditions[0].reason = 'ProgressDeadlineExceeded';
  assert.equal(readback({deployments:healthy,pods:p,short:'abcdef0'})
    .deployments[0].conditions[0].reason,'ProgressDeadlineExceeded');
  healthy.items[0].status.conditions[0].reason = token;
  assert.equal(readback({deployments:healthy,pods:p,short:'abcdef0'})
    .deployments[0].conditions[0].reason,'other');
  const absent = readback({deployments:d,pods:p,short:'abcdef0'});
  assert.equal(absent.event_access,'not-authorized');
  assert.equal(absent.pod_events.length,0);
  assert.throws(()=>readback({deployments:d,pods:{items:new Array(501)},short:'abcdef0'}));
  assert.throws(()=>readback({deployments:d,pods:p,events:{items:new Array(1001)},short:'abcdef0'}));
  assert.throws(()=>readback({deployments:d,pods:p,short:token}));
  const malicious = structuredClone(p);
  malicious.items[0].status.containerStatuses[0].state.waiting.reason = token;
  assert.equal(readback({deployments:d,pods:malicious,short:'abcdef0'})
    .pod_status[0].containers[0].waiting_reason,'other');
  console.log('Staging rollout readback: source binding, role ownership, exit reasons, safe events, redaction, and bounded negatives passed');
}
function main() {
  if (process.argv[2] === 'self-test') return selfTest();
  if (process.argv[2] !== 'run' || process.argv.length !== 7) {
    throw Error('usage: run <deployments.json> <pods.json> <events.json|none> <short-sha>');
  }
  const load = p => JSON.parse(fs.readFileSync(p,'utf8'));
  const [dep,pod,event,short] = process.argv.slice(3);
  const result = readback({deployments:load(dep),pods:load(pod),
    events:event === 'none' ? null : load(event),short});
  process.stdout.write(JSON.stringify(result) + '\n');
}
try { main(); } catch {
  // Never log raw Kubernetes input, data-dependent errors, paths or credential fragments.
  console.error('STAGING_READBACK_REJECTED_V2 invalid/unbounded read-only input');
  process.exitCode = 1;
}
