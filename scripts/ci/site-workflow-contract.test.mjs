#!/usr/bin/env node
// Exact-head workflow contract tests (#4589 SC-05): trusted main-only
// execution, fixed dispatch choices, credential scoping, read-only plan,
// receipt-bound apply, shared DNS-authority concurrency, bot-push-independent
// triggers and always() VPN cleanup. These are deterministic source
// assertions; actual protected GitHub server authorization is SCN-04/07.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const text = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-configure-site.yml'), 'utf8');

function jobSection(id) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line === '  ' + id + ':');
  assert.notEqual(start, -1, 'job missing: ' + id);
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-z0-9_-]+:\s*$/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

const jobs = ['verify', 'gitops-compare', 'lan-plan', 'public-plan', 'lan-apply', 'public-apply', 'issue_tls'];

test('workflow keeps the reviewed delivery identity and runner pin', () => {
  assert.ok(text.startsWith('name: Deploy / Configure Site\n'));
  assert.equal(text.includes('ubuntu-latest'), false);
  for (const id of jobs) {
    assert.ok(jobSection(id).includes('runs-on: ubuntu-24.04'), id);
  }
});

test('every job is trusted main-only', () => {
  for (const id of jobs) {
    const section = jobSection(id);
    assert.ok(section.includes("github.repository == 'BestNathan/nession'"), id);
    assert.ok(section.includes("github.ref == 'refs/heads/main'"), id);
  }
});

test('triggers are main contract changes, hourly read-only plan and manual dispatch only', () => {
  assert.ok(/push:\s*\n\s*branches: \[main\]\s*\n\s*paths:/.test(text));
  assert.ok(text.includes("cron: '17 * * * *'"));
  assert.equal(text.includes('workflow_run:'), false);
  assert.equal(text.includes('pull_request_target:'), false);
  assert.equal(text.includes('pull_request:'), false);
  const pushBlock = text.slice(text.indexOf('  push:'), text.indexOf('  schedule:'));
  assert.ok(pushBlock.includes('scripts/ci/site-registry/**'));
  assert.equal(/branches:\s*\[main\]/.test(pushBlock), true);
});

test('dispatch inputs are fixed choices; no arbitrary hostname/IP/URL/shell/branch input', () => {
  const dispatch = text.slice(text.indexOf('  workflow_dispatch:'), text.indexOf('  push:'));
  for (const input of ['environment', 'site', 'action']) {
    assert.ok(new RegExp(input + ':\\s*\\n[\\s\\S]*?type: choice').test(dispatch), input);
  }
  assert.ok(/plan_run_id:\s*\n[\s\S]*?type: string/.test(dispatch));
  const inputNames = [...dispatch.matchAll(/^      ([a-z_]+):$/gm)].map(match => match[1]);
  assert.deepEqual(inputNames.sort(), ['action', 'environment', 'plan_run_id', 'site']);
  for (const forbidden of ['hostname', 'fqdn', 'ip', 'url', 'shell', 'branch', 'ref', 'command']) {
    assert.equal(inputNames.includes(forbidden), false, forbidden);
  }
  assert.ok(dispatch.includes('- staging-mcp'));
  assert.ok(dispatch.includes('- production-mcp'));
  assert.ok(dispatch.includes('- all'));
});

test('Cloudflare credentials never reach LAN jobs; VPN/AdGuard credentials never reach public jobs', () => {
  for (const id of ['lan-plan', 'lan-apply']) {
    const section = jobSection(id);
    for (const secret of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ORIGIN_IPV4', 'CLOUDFLARE_ZONE_ID']) {
      assert.equal(section.includes(secret), false, id + ' must not hold ' + secret);
    }
    assert.ok(section.includes('ADGUARD_PASSWORD'), id);
    assert.ok(section.includes('GOST_RELAY_URL'), id);
  }
  for (const id of ['public-plan', 'public-apply']) {
    const section = jobSection(id);
    for (const secret of ['ADGUARD_PASSWORD', 'ADGUARD_USERNAME', 'GOST_RELAY_URL', 'LAN_GATEWAY_IP']) {
      assert.equal(section.includes(secret), false, id + ' must not hold ' + secret);
    }
    assert.ok(section.includes('CLOUDFLARE_API_TOKEN'), id);
  }
  assert.equal(jobSection('issue_tls').includes('ADGUARD_PASSWORD'), false);
  assert.equal(jobSection('verify').includes('CLOUDFLARE_API_TOKEN'), false);
  assert.equal(jobSection('gitops-compare').includes('CLOUDFLARE_API_TOKEN'), false);
});

test('LAN jobs start the AdGuard-only tunnel and clean up on always()', () => {
  for (const id of ['lan-plan', 'lan-apply']) {
    const section = jobSection(id);
    assert.ok(section.includes('bash scripts/ci/site-dns-tunnel.sh start'), id);
    assert.ok(/if: always\(\)\s*\n\s*run: bash scripts\/ci\/site-dns-tunnel\.sh cleanup/.test(section), id);
  }
});

test('mutations serialize by shared DNS authority and never cancel in-flight runs', () => {
  const concurrency = text.slice(text.indexOf('concurrency:'), text.indexOf('permissions:'));
  assert.ok(concurrency.includes('cancel-in-progress: false'));
  assert.ok(concurrency.includes('site-dns-'));
  assert.ok(concurrency.includes("'writer'"));
  assert.ok(concurrency.includes("'plan'"));
  assert.ok(concurrency.includes("inputs.action == 'apply'"));
  assert.ok(concurrency.includes("inputs.action == 'reconcile'"));
  assert.ok(concurrency.includes("inputs.action == 'delete'"));
  const issueTls = jobSection('issue_tls');
  assert.ok(issueTls.includes('group: gitops-writer'));
  assert.ok(issueTls.includes('cancel-in-progress: false'));
});

test('plan jobs are read-only; apply jobs require an authenticated reviewed plan receipt', () => {
  for (const id of ['lan-plan', 'public-plan']) {
    const section = jobSection(id);
    assert.equal(section.includes("inputs.action == 'apply'"), false, id);
    assert.equal(section.includes("'reconcile'"), false, id);
    assert.ok(section.includes('SITE_PLAN_OUT'), id);
    assert.ok(section.includes('actions/upload-artifact@v4'), id);
  }
  for (const id of ['lan-apply', 'public-apply']) {
    const section = jobSection(id);
    assert.ok(section.includes('[[ "$PLAN_RUN_ID" =~ ^[1-9][0-9]*$ ]]'), id);
    assert.ok(section.includes("r.path==='.github/workflows/deploy-configure-site.yml'"), id);
    assert.ok(section.includes("r.head_branch==='main'"), id);
    assert.ok(section.includes('r.head_sha===process.env.GITHUB_SHA'), id);
    assert.ok(section.includes("r.conclusion==='success'"), id);
    assert.ok(section.includes('SITE_PLAN_RECEIPT'), id);
    assert.ok(section.includes('gh run download'), id);
  }
  assert.ok(jobSection('lan-apply').includes('site-registry.mjs lan-readiness'));
  assert.ok(jobSection('lan-apply').includes('SITE_READY_SITES'));
});

test('verify job executes the full deterministic site contract suite', () => {
  const section = jobSection('verify');
  for (const file of [
    'scripts/ci/site-registry/site-registry.test.mjs',
    'scripts/ci/configure-cloudflare-site.test.mjs',
    'scripts/ci/configure-adguard-dns.test.mjs',
    'scripts/ci/site-registry/edge-policy.test.mjs',
    'scripts/ci/site-registry/retire-origin-ca.test.mjs',
    'scripts/ci/issue-cloudflare-origin-ca.test.mjs',
    'scripts/ci/site-workflow-contract.test.mjs'
  ]) {
    assert.ok(section.includes(file), file);
  }
  assert.ok(section.includes('site-registry.mjs validate'));
  assert.ok(section.includes('edge-policy.mjs check-fixture'));
  assert.ok(section.includes('retire-origin-ca.mjs check-source'));
  assert.ok(section.includes('bash scripts/ci/site-dns-tunnel.sh self-test'));
});

test('GitOps comparison runs at a pinned revision and receipts are retained', () => {
  const compare = jobSection('gitops-compare');
  assert.ok(compare.includes('ref: gitops'));
  assert.ok(compare.includes('site-registry.mjs compare'));
  assert.ok(compare.includes('git -C gitops rev-parse HEAD'));
  assert.ok(compare.includes('name: site-gitops-comparison'));
  for (const id of ['lan-plan', 'public-plan', 'lan-apply', 'public-apply']) {
    assert.ok(jobSection(id).includes('retention-days: 90'), id);
  }
});
