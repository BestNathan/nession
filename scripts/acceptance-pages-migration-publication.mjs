#!/usr/bin/env node
// Trusted-main post-merge evidence for the React/Vite Pages migration (#4448).
// Authenticates the exact-main Deploy / Public Pages Run/Attempt and its
// publisher job log, then independently re-downloads the anonymous HTTPS
// artifact manifest and every compiled byte before exposing evidence to the
// independent Agent. It never projects an SC verdict or executes PR code.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {attestPagesDeployment} from './acceptance-pages-deployment-receipt.mjs';
import {parseWorkflowPublicationLog, formatWorkflowPublication}
  from '../pages/scripts/publication-receipt.mjs';
import {verifyPublishedArtifact} from '../pages/scripts/verify-published-artifact.mjs';

const REPO = 'BestNathan/nession';
const ISSUE = 4448;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const WORKFLOW_NAME = 'Deploy / Public Pages';
const WORKFLOW_PATH = '.github/workflows/deploy-pages.yml';
const PUBLIC_BASE = 'https://bestnathan.github.io/nession';
const MANIFEST_LINE = /Artifact manifest SHA-256: `([a-f0-9]{64})`/g;
const CLOSURE_LINE = /Compiled Pages closure: ([0-9]+) files · digest `([a-f0-9]{64})`/g;
const PROTOCOL_LINE = /Public Protocol Documents verified: main_sha=([a-f0-9]{40}) protocols=([0-9]+) json_sha256=([a-f0-9]{64})/g;
const KNOWLEDGE_LINE = /Public Knowledge verified: source=([a-f0-9]{40}) articles=([0-9]+) digest=([a-f0-9]{64})/g;
const SANDBOX_LINE = /Public Sandbox prototype verified: source=([a-f0-9]{40}) html_sha256=([a-f0-9]{64})/g;
const MCP_LINE = /MCP Documents published: tools=([0-9]+) source=([a-f0-9]{40}) semantic=([a-f0-9]{64})/g;

const hash = (value) => createHash('sha256').update(value).digest('hex');

function single(log, pattern, label) {
  const matches = [...log.matchAll(pattern)];
  assert.equal(matches.length, 1, 'missing or ambiguous ' + label + ' public receipt');
  return matches[0];
}

export function shouldCollectPagesMigrationPublication(stage, issue) {
  return stage === 'post-merge' && String(issue) === String(ISSUE);
}

export function attestPagesMigrationPublication(repo, sha, run, jobs, log) {
  assert.match(sha, SHA);
  const proof = attestPagesDeployment(repo, sha, run, jobs, log);
  const manifestMatch = single(log, MANIFEST_LINE, 'artifact manifest');
  const closureMatch = single(log, CLOSURE_LINE, 'compiled closure');
  const protocolMatch = single(log, PROTOCOL_LINE, 'Protocol Documents');
  const knowledgeMatch = single(log, KNOWLEDGE_LINE, 'Knowledge');
  const sandboxMatch = single(log, SANDBOX_LINE, 'Sandbox prototype');
  const mcpMatches = [...log.matchAll(MCP_LINE)];
  assert.ok(mcpMatches.length <= 1, 'ambiguous MCP public receipt');
  const manifestSha = manifestMatch[1];
  const files = Number(closureMatch[1]);
  const closureSha = closureMatch[2];
  assert.ok(Number.isSafeInteger(files) && files > 0 && files <= 64);
  assert.match(manifestSha, DIGEST);
  assert.match(closureSha, DIGEST);
  assert.equal(protocolMatch[1], sha, 'Protocol readback main SHA mismatch');
  assert.match(knowledgeMatch[1], SHA);
  assert.match(sandboxMatch[1], SHA);
  for (const match of mcpMatches) assert.match(match[2], SHA);
  const publication = parseWorkflowPublicationLog(log, sha);
  return Object.freeze({
    schema_version: 1,
    kind: 'verified_public_pages_migration_publication',
    repository: REPO,
    issue: ISSUE,
    target_sha: sha,
    deploy_run: {
      id: proof.run_id,
      run_attempt: proof.run_attempt,
      workflow: WORKFLOW_NAME,
      workflow_path: WORKFLOW_PATH,
      build_job_id: proof.build_job_id,
      publish_job_id: proof.publish_job_id,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
    },
    artifact_manifest_sha256: manifestSha,
    artifact_closure_sha256: closureSha,
    artifact_files: files,
    entrypoints: ['index.html', 'workflows.html'],
    published_data: {
      site_json_sha256: proof.digest,
      knowledge_source_sha: knowledgeMatch[1],
      knowledge_articles: Number(knowledgeMatch[2]),
      knowledge_json_sha256: knowledgeMatch[3],
      protocol_main_sha: protocolMatch[1],
      protocol_units: Number(protocolMatch[2]),
      protocol_json_sha256: protocolMatch[3],
      mcp:
        mcpMatches.length === 1
          ? {
              tools: Number(mcpMatches[0][1]),
              source_sha: mcpMatches[0][2],
              semantic_sha256: mcpMatches[0][3],
            }
          : null,
      prototype_source_sha: sandboxMatch[1],
      prototype_sandbox_sha256: sandboxMatch[2],
      workflow_nodes: publication.nodes,
      workflow_json_sha256: publication.json_sha256,
      workflow_html_sha256: publication.html_sha256,
    },
    public_url: PUBLIC_BASE + '/',
    source_url: 'https://github.com/' + repo + '/actions/runs/' + proof.run_id,
    verified_by:
      'GitHub exact Run/Attempt/Jobs and bounded anonymous HTTPS manifest/closure readback',
    establishes_sc_verdict: false,
    implements_pr_linkage: false,
  });
}

export async function collectPagesMigrationPublications(
  repo,
  sha,
  runs,
  request,
  readJobLog,
  {verify = verifyPublishedArtifact} = {},
) {
  if (repo !== REPO || !SHA.test(sha) || !Array.isArray(runs)) {
    throw Error('invalid Pages migration publication request');
  }
  const candidates = runs
    .filter((run) =>
      run?.name === WORKFLOW_NAME &&
      run.path === WORKFLOW_PATH &&
      run.head_sha === sha &&
      run.event === 'push' &&
      run.status === 'completed' &&
      run.conclusion === 'success')
    .sort((a, b) => b.id - a.id)
    .slice(0, 3);
  for (const candidate of candidates) {
    const run = await request('/repos/' + repo + '/actions/runs/' + candidate.id);
    if (run?.id !== candidate.id) throw Error('Pages deployment Run identity changed');
    const jobs = await request('/repos/' + repo + '/actions/runs/' + run.id +
      '/attempts/' + run.run_attempt + '/jobs?per_page=100');
    const publisher = jobs?.jobs?.filter((job) =>
      job?.name === 'Publish independent Pages' && job.run_id === run.id &&
      job.run_attempt === run.run_attempt);
    assert.equal(publisher?.length, 1, 'missing unique Pages publisher job');
    const log = await readJobLog('/repos/' + repo + '/actions/jobs/' +
      publisher[0].id + '/logs');
    const receipt = attestPagesMigrationPublication(repo, sha, run, jobs, log);
    const verified = await verify({
      base: PUBLIC_BASE,
      expectedManifestSha: receipt.artifact_manifest_sha256,
      revision: sha,
      attempts: 3,
      delayMs: 5000,
    });
    assert.equal(JSON.stringify(verified.manifest.entrypoints), JSON.stringify(['index.html', 'workflows.html']));
    assert.equal(verified.manifest.closure_sha256, receipt.artifact_closure_sha256);
    assert.equal(verified.manifest.files.length, receipt.artifact_files);
    assert.equal(verified.files, verified.manifest.files.length);
    return [receipt];
  }
  return [];
}

function selfTestFixture() {
  const sha = 'a'.repeat(40);
  const run = {
    id: 101, run_attempt: 1, name: WORKFLOW_NAME, path: WORKFLOW_PATH,
    event: 'push', head_branch: 'main', head_sha: sha, status: 'completed',
    conclusion: 'success', repository: {full_name: REPO},
    head_repository: {full_name: REPO},
  };
  const step = (name) => ({name, conclusion: 'success'});
  const jobs = {
    jobs: [
      {id: 201, run_id: 101, run_attempt: 1, head_sha: sha,
        name: 'Build independent Pages', status: 'completed', conclusion: 'success',
        steps: [step('Capture exact static public evidence digest and coverage'),
          step('Upload standalone Pages')]},
      {id: 202, run_id: 101, run_attempt: 1, head_sha: sha,
        name: 'Publish independent Pages', status: 'completed', conclusion: 'success',
        steps: [step('Deploy GitHub Pages'),
          step('Verify public site URL and exact deployed main SHA')]},
    ],
  };
  const manifest = 'b'.repeat(64);
  const closure = 'c'.repeat(64);
  const topology = formatWorkflowPublication({
    main_sha: sha, nodes: 27, json_sha256: 'd'.repeat(64),
    html_sha256: 'e'.repeat(64),
  });
  const log = [
    '2026-11-24T08:00:00Z Public Issue Agent Run observation: source_backed_observation (source=available, runs=3, digest=' + 'f'.repeat(64) + ')',
    'Public Protocol Documents verified: main_sha=' + sha + ' protocols=42 json_sha256=' + '1'.repeat(64),
    'Public Knowledge verified: source=' + '2'.repeat(40) + ' articles=9 digest=' + '3'.repeat(64),
    'MCP Documents published: tools=12 source=' + sha + ' semantic=' + '4'.repeat(64),
    'Public Sandbox prototype verified: source=' + '5'.repeat(40) + ' html_sha256=' + '6'.repeat(64),
    '2026-11-24T08:00:01Z ' + topology,
    'Compiled Pages closure: 8 files · digest `' + closure + '`',
    'Artifact manifest SHA-256: `' + manifest + '` (trusted build output)',
    '',
  ].join('\n');
  return {sha, run, jobs, log, manifest, closure, topology};
}

export async function selfTestPagesMigrationPublication() {
  const {sha, run, jobs, log, manifest, closure, topology} = selfTestFixture();
  const receipt = attestPagesMigrationPublication(REPO, sha, run, jobs, log);
  assert.equal(receipt.kind, 'verified_public_pages_migration_publication');
  assert.equal(receipt.artifact_manifest_sha256, manifest);
  assert.equal(receipt.artifact_closure_sha256, closure);
  assert.equal(receipt.published_data.protocol_units, 42);
  assert.equal(receipt.published_data.knowledge_articles, 9);
  assert.equal(receipt.published_data.mcp.tools, 12);
  assert.equal(receipt.establishes_sc_verdict, false);
  const deny = (edit) => assert.throws(() =>
    attestPagesMigrationPublication(REPO, sha, edit.run ?? run, edit.jobs ?? jobs,
      edit.log ?? log));
  deny({run: {...run, head_sha: 'c'.repeat(40)}});
  deny({run: {...run, conclusion: 'failure'}});
  deny({jobs: {jobs: jobs.jobs.slice(0, 1)}});
  deny({log: log.replace(/Artifact manifest SHA-256:[^\n]*\n/, '')});
  deny({log: log.replace(/Compiled Pages closure:[^\n]*\n/, '')});
  deny({log: log + '\nCompiled Pages closure: 8 files · digest `' + closure + '`'});
  deny({log: log.replace('main_sha=' + sha + ' protocols=42', 'main_sha=' + 'b'.repeat(40) + ' protocols=42')});
  deny({log: log.replace('Public Knowledge verified:', 'Public Knowledge unavailable:')});
  deny({log: log.replace('Public Sandbox prototype verified:', 'Public Sandbox prototype unverified:')});
  deny({log: log.replace(topology, topology.replace('nodes=27', 'nodes=0'))});
  const verified = await collectPagesMigrationPublications(
    REPO, sha, [{...run}],
    async (path) => path.endsWith('/jobs?per_page=100') ? jobs : run,
    async () => log,
    {verify: async ({expectedManifestSha, revision}) => {
      assert.equal(expectedManifestSha, manifest);
      assert.equal(revision, sha);
      return {
        manifest: {
          entrypoints: ['index.html', 'workflows.html'],
          files: Array.from({length: 8}, (_, index) => ({path: 'file-' + index})),
          closure_sha256: closure,
        },
        files: 8,
      };
    }},
  );
  assert.equal(verified.length, 1);
  await assert.rejects(() => collectPagesMigrationPublications(
    REPO, sha, [{...run}],
    async (path) => path.endsWith('/jobs?per_page=100') ? jobs : run,
    async () => log,
    {verify: async () => ({
      manifest: {
        entrypoints: ['index.html', 'workflows.html'],
        files: Array.from({length: 8}, (_, index) => ({path: 'file-' + index})),
        closure_sha256: '9'.repeat(64),
      },
      files: 8,
    })},
  ), /AssertionError/);
  assert.deepEqual(await collectPagesMigrationPublications(
    REPO, sha, [{...run, conclusion: 'failure'}],
    async () => run, async () => log), []);
  console.log('Pages migration publication: exact main Run/Attempt/Jobs, manifest/closure HTTPS readback and fail-closed negatives passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'self-test') {
    selfTestPagesMigrationPublication().catch((error) => {
      console.error(error.stack || error);
      process.exitCode = 1;
    });
  } else {
    throw Error('usage: acceptance-pages-migration-publication.mjs self-test');
  }
}
