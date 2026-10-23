#!/usr/bin/env node
// Narrow read-only bridge for #2225 SC-04. Issue comments and model prose
// nominate evidence but never authenticate a run, GitOps commit or readback.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const REPO = 'BestNathan/nession';
const TARGET = '1790d9fc08ae6f6f97028e53d99f1687e4de40bd';
const REGISTRY = 'crpi-ck06yio90i1ttwlz.cn-beijing.personal.cr.aliyuncs.com/n_public/nession';
const OVERLAY = 'environments/staging/nession/kustomization.yaml';
const HISTORICAL_CUTOVER = 'd3362cf82a8adbb3337c2339bb7c199bbb0ada81';
const CURRENT_GITOPS = 'e553126ac99e50e10e8d02a56dead8590785b8ae';
const RUNTIME_RUN = 39921135942;
const ANONYMOUS_RUN = 39901778486;
const RELEASE_RUN = 39822246209;
const SHA = /^[0-9a-f]{40}$/;

const SOURCE = {
  runtime: {
    id: RUNTIME_RUN,
    sha: '963d25d58ce73707604f0fb3a4bd92e35d564ada',
    name: 'CI / WireGuard K8s Staging Readback (temporary)',
    path: '.github/workflows/ci-wg-k8s-2225-smoke.yml',
    branch: 'test/wireguard-ci-k8s-2225-20261023',
  },
  anonymous: {
    id: ANONYMOUS_RUN,
    sha: '93b4bb199259ab253e5b18321b232b6b608f35ee',
    name: 'Release / ACR Staging Public Readback (temporary)',
    path: '.github/workflows/release-acr-staging-readback-2225.yml',
    branch: 'test/acr-staging-readback-2225',
  },
  release: {
    id: RELEASE_RUN,
    sha: TARGET,
    name: 'Release / Staging Artifacts',
    path: '.github/workflows/release-staging.yml',
    branch: 'staging',
  },
};

export function shouldCollectStagingAcr(issue, stage, sha) {
  return String(issue) === '2225' && stage === 'staging' && sha === TARGET;
}

export function verifyRun(run, spec) {
  assert.equal(run?.id, spec.id, 'ACR evidence run ID mismatch');
  assert.equal(run?.repository?.full_name, REPO, 'ACR evidence repository mismatch');
  assert.equal(run?.head_repository?.full_name, REPO, 'ACR evidence source repository mismatch');
  assert.equal(run?.actor?.login, 'BestNathan', 'ACR evidence must be owner initiated');
  assert.equal(run?.event, 'push', 'ACR evidence must be a source push');
  assert.equal(run?.name, spec.name, 'ACR evidence workflow name mismatch');
  assert.equal(run?.path, spec.path, 'ACR evidence workflow path mismatch');
  assert.equal(run?.head_branch, spec.branch, 'ACR evidence source branch mismatch');
  assert.equal(run?.head_sha, spec.sha, 'ACR evidence source SHA mismatch');
  assert.equal(run?.status, 'completed', 'ACR evidence incomplete');
  assert.equal(run?.conclusion, 'success', 'ACR evidence run failed');
  assert.equal(run?.run_attempt, 1, 'ACR evidence attempt must be exact');
  return { run_id: run.id, attempt: run.run_attempt, source_sha: run.head_sha,
    url: 'https://github.com/' + REPO + '/actions/runs/' + run.id };
}

export function verifyJobs(jobs, expected) {
  assert.ok(Array.isArray(jobs?.jobs), 'missing Actions jobs');
  assert.equal(jobs.jobs.length, expected.length, 'unexpected Actions job count');
  const byName = new Map();
  for (const job of jobs.jobs) {
    assert.ok(!byName.has(job.name), 'duplicate Actions job');
    assert.equal(job.status, 'completed', 'incomplete Actions job');
    assert.equal(job.conclusion, 'success', 'failed Actions job');
    assert.ok(Number.isSafeInteger(job.id) && job.id > 0, 'invalid job ID');
    byName.set(job.name, job);
  }
  assert.deepEqual([...byName.keys()].sort(), [...expected].sort(), 'unexpected Actions job set');
  return byName;
}

export function parseRuntimeLog(log, tag) {
  assert.equal(typeof log, 'string', 'missing Kubernetes run log');
  assert.ok(log.includes('Both CI secrets are non-empty and available to this job. No secret values logged.'),
    'CI secret availability step did not complete');
  assert.ok(log.includes('WireGuard interface activated (key and peer configuration redacted).'),
    'no successful WireGuard startup');
  assert.ok(log.includes('Read-only staging Kubernetes API observation completed.'),
    'no completed Kubernetes API observation');
  assert.ok(log.includes('Temporary VPN and kubeconfig files cleared.'),
    'VPN cleanup completion not found');
  const lines = log.split('\n').filter(line => /Z \{"deployments":\[/.test(line));
  assert.equal(lines.length, 1, 'expected one live Kubernetes Deployment readback');
  const parsed = JSON.parse(lines[0].slice(lines[0].indexOf('Z {"deployments":') + 2));
  const names = ['agent', 'server', 'ui'];
  assert.equal(parsed?.deployments?.length, names.length, 'missing staging Deployment');
  const result = parsed.deployments.map(item => {
    assert.ok(names.some(name => item.name === 'nession-' + name + '-staging'),
      'unexpected Deployment identity');
    const role = item.name.slice('nession-'.length, -'-staging'.length);
    assert.deepEqual(item.images, [REGISTRY + ':' + role + '-' + tag],
      'staging workload is not using the target ACR image');
    assert.ok(Number.isInteger(item.generation) && item.generation > 0,
      'invalid Deployment generation');
    assert.equal(item.observedGeneration, item.generation, 'Deployment not observed');
    assert.ok(item.replicas > 0 && item.readyReplicas >= item.replicas,
      'staging workload not Ready');
    return { name: item.name, image: item.images[0], ready: item.readyReplicas,
      desired: item.replicas, generation: item.generation };
  });
  assert.deepEqual(result.map(x => x.name).sort(),
    names.map(x => 'nession-' + x + '-staging').sort(), 'duplicate staging Deployments');
  return result;
}

export function verifyAnonymousLog(log, tag) {
  assert.equal(typeof log, 'string', 'missing anonymous registry run log');
  assert.ok(log.includes('Checking anonymous ACR manifest for ' + tag + '; no registry login credentials are configured'),
    'anonymous registry validation missing for ' + tag);
  assert.ok(log.includes('Anonymous ACR readback verified: ' + tag + ' (amd64 and arm64)'),
    'manifest platform validation absent for ' + tag);
}

export function verifyCutover(commit) {
  assert.equal(commit?.sha, HISTORICAL_CUTOVER, 'historical GitOps commit mismatch');
  assert.equal(commit?.files?.length, 1, 'historical cutover modified unrelated files');
  assert.equal(commit.files[0].filename, OVERLAY, 'historical cutover was not staging-only');
  const patch = commit.files[0].patch ?? '';
  assert.equal((patch.match(/^-  newName: ghcr\.io\/bestnathan\/nession$/gm) ?? []).length, 3,
    'historical GHCR source entries missing');
  assert.equal(patch.split('\n').filter(line => line === '+  newName: ' + REGISTRY).length, 3,
    'historical ACR target entries missing');
  assert.ok(!/^[+-]\s*newTag:/m.test(patch), 'historical tag changed during registry cutover');
  return { gitops_commit: HISTORICAL_CUTOVER, changed_file: OVERLAY,
    registry_only: true, tag: 'e0ce848' };
}

function decodeGitHubFile(response) {
  assert.equal(response?.encoding, 'base64', 'unsupported GitHub file encoding');
  assert.ok(typeof response.content === 'string', 'missing GitOps manifest');
  return Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8');
}

export function verifyOverlays(staging, otherOverlays, tag) {
  const lines = staging.split('\n');
  const names = lines.filter(line => /^  newName: /.test(line)).map(line => line.trim().slice(9));
  const tags = lines.filter(line => /^  newTag: /.test(line)).map(line => line.trim().slice(8));
  assert.deepEqual(names, [REGISTRY, REGISTRY, REGISTRY],
    'staging GitOps has reverted away from ACR');
  assert.deepEqual(tags, ['agent-' + tag, 'server-' + tag, 'ui-' + tag],
    'GitOps staging desired tag differs from target revision');
  for (const [env, manifest] of Object.entries(otherOverlays)) {
    const otherNames = manifest.split('\n')
      .filter(line => /^  newName: /.test(line)).map(line => line.trim().slice(9));
    assert.deepEqual(otherNames, Array(3).fill('ghcr.io/bestnathan/nession'),
      env + ' changed away from GHCR');
  }
}

export async function collectStagingAcrEvidence({repo, sha, get, getText}) {
  assert.equal(repo, REPO, 'unexpected repository');
  assert.ok(SHA.test(sha), 'exact source SHA required');
  assert.equal(sha, TARGET, 'SC-04 historical runtime readback is not scoped to this SHA');
  const prefix = '/repos/' + REPO;
  const [runtimeRun, anonymousRun, releaseRun, cutover, tip, manifest, others] =
    await Promise.all([
      get(prefix + '/actions/runs/' + RUNTIME_RUN),
      get(prefix + '/actions/runs/' + ANONYMOUS_RUN),
      get(prefix + '/actions/runs/' + RELEASE_RUN),
      get(prefix + '/commits/' + HISTORICAL_CUTOVER),
      get(prefix + '/git/ref/heads/gitops'),
      get(prefix + '/contents/' + OVERLAY + '?ref=' + CURRENT_GITOPS),
      Promise.all(['production', 'preprod', 'staging-01'].map(async env =>
        [env, decodeGitHubFile(await get(prefix + '/contents/environments/' +
          env + '/nession/kustomization.yaml?ref=' + CURRENT_GITOPS))])),
    ]);
  const sources = {
    runtime: verifyRun(runtimeRun, SOURCE.runtime),
    anonymous: verifyRun(anonymousRun, SOURCE.anonymous),
    release: verifyRun(releaseRun, SOURCE.release),
  };
  assert.equal(tip?.object?.sha, CURRENT_GITOPS, 'GitOps advanced; historical readback is stale');
  const historical = verifyCutover(cutover);
  verifyOverlays(decodeGitHubFile(manifest), Object.fromEntries(others), sha.slice(0, 7));
  const [runtimeJobs, registryJobs, releaseJobs] = await Promise.all([
    get(prefix + '/actions/runs/' + RUNTIME_RUN + '/attempts/1/jobs?per_page=100'),
    get(prefix + '/actions/runs/' + ANONYMOUS_RUN + '/attempts/1/jobs?per_page=100'),
    get(prefix + '/actions/runs/' + RELEASE_RUN + '/attempts/1/jobs?per_page=100'),
  ]);
  const runtime = verifyJobs(runtimeJobs, ['private-k8s-readback']);
  const expectedAnonymous = ['agent', 'server', 'ui'].flatMap(role =>
    ['e0ce848', '1790d9f'].map(tag => 'anonymous-readback (' + role + ', ' + tag + ')'));
  const anonymous = verifyJobs(registryJobs, expectedAnonymous);
  const release = new Map((releaseJobs?.jobs ?? []).map(job => [job.name, job]));
  for (const name of ['mirror-acr (agent)', 'mirror-acr (server)',
    'mirror-acr (ui)', 'deploy-staging-gitops']) {
    assert.equal(release.get(name)?.conclusion, 'success', name + ' was not successful');
  }
  const runtimeJob = runtime.get('private-k8s-readback');
  const deployments = parseRuntimeLog(await getText(prefix + '/actions/jobs/' + runtimeJob.id + '/logs'), sha.slice(0, 7));
  for (const [jobName, job] of anonymous) {
    const tag = jobName.slice('anonymous-readback ('.length, -1).replace(', ', '-');
    verifyAnonymousLog(await getText(prefix + '/actions/jobs/' + job.id + '/logs'), tag);
  }
  return { kind: 'verified_staging_acr_readback', schema_version: 1,
    issue: 2225, criterion: 'SC-04', stage: 'staging', target_sha: sha,
    trust: 'independently re-read exact GitHub run and job identities, logs, and GitOps commit',
    source_runs: sources, historical, gitops_commit: CURRENT_GITOPS,
    current_images: deployments,
    anonymous_registry_tags: ['agent', 'server', 'ui'].flatMap(role =>
      ['e0ce848', '1790d9f'].map(tag => role + '-' + tag)),
    other_environments_kept_on_ghcr: ['production', 'preprod', 'staging-01'],
    limitations: 'Deployment Ready/observed generation proves current live K8s state; historical e0ce848 is proven by GitOps diff and anonymous registry manifest readback, not claimed to remain running',
  };
}

export function selfTestStagingAcrEvidence() {
  const run = {id:RUNTIME_RUN,repository:{full_name:REPO},head_repository:{full_name:REPO},
    actor:{login:'BestNathan'},event:'push',name:SOURCE.runtime.name,
    path:SOURCE.runtime.path,head_branch:SOURCE.runtime.branch,head_sha:SOURCE.runtime.sha,
    status:'completed',conclusion:'success',run_attempt:1};
  assert.equal(verifyRun(run,SOURCE.runtime).run_id,RUNTIME_RUN);
  assert.throws(() => verifyRun({...run,conclusion:'failure'},SOURCE.runtime));
  assert.throws(() => verifyRun({...run,actor:{login:'attacker'}},SOURCE.runtime));
  assert.throws(() => verifyRun({...run,head_sha:'0'.repeat(40)},SOURCE.runtime));
  const entry = role => ({name:'nession-'+role+'-staging',generation:2,observedGeneration:2,
    replicas:1,readyReplicas:1,images:[REGISTRY+':'+role+'-1790d9f']});
  const json=JSON.stringify({deployments:['server','agent','ui'].map(entry)});
  const log=['Both CI secrets are non-empty and available to this job. No secret values logged.',
    'WireGuard interface activated (key and peer configuration redacted).',
    '2026-10-23T00:00:00Z '+json,
    'Read-only staging Kubernetes API observation completed.',
    'Temporary VPN and kubeconfig files cleared.'].join('\n');
  assert.equal(parseRuntimeLog(log,'1790d9f').length,3);
  assert.throws(() => parseRuntimeLog(log.replace('readyReplicas":1','readyReplicas":0'),'1790d9f'));
  assert.throws(() => parseRuntimeLog(log.replace('agent-1790d9f','agent-e0ce848'),'1790d9f'));
  assert.throws(() => parseRuntimeLog(log.replace('cleared.','not cleaned.'),'1790d9f'));
  const initial='-  newName: ghcr.io/bestnathan/nession\n+  newName: '+REGISTRY+'\n';
  assert.equal(verifyCutover({sha:HISTORICAL_CUTOVER,
    files:[{filename:OVERLAY,patch:initial.repeat(3)}]}).registry_only,true);
  assert.throws(() => verifyCutover({sha:HISTORICAL_CUTOVER,
    files:[{filename:OVERLAY,patch:initial.repeat(3)+'-  newTag: old\n+  newTag: new\n'}]}));
  const st=['agent','server','ui'].map(role =>
    '  newName: '+REGISTRY+'\n  newTag: '+role+'-1790d9f').join('\n');
  const gh=Array(3).fill('  newName: ghcr.io/bestnathan/nession').join('\n');
  verifyOverlays(st,{production:gh,preprod:gh,'staging-01':gh},'1790d9f');
  assert.throws(() => verifyOverlays(st.replace('agent-1790d9f','agent-1234567'),
    {production:gh},'1790d9f'));
  assert.equal(shouldCollectStagingAcr(2225,'staging',TARGET),true);
  assert.equal(shouldCollectStagingAcr(2225,'pre-merge',TARGET),false);
  assert.equal(shouldCollectStagingAcr(9999,'staging',TARGET),false);
  console.log('staging ACR readback: verified positive/negative source and runtime boundaries');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === 'self-test') selfTestStagingAcrEvidence();
  else throw Error('usage: acceptance-staging-acr-readback.mjs self-test');
}
