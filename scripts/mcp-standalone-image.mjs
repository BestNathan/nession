#!/usr/bin/env node
// #3791 SC-01/SC-04: standalone MCP host OCI image source contract.
//
// Proves one release family without building an image: the dedicated
// `Dockerfile.mcp.prebuilt` selects the architecture-matched `nession-mcp`
// binary, carries no Server/Agent/UI/toolchain payload and no credential, the
// staging and production lanes publish `mcp-<tag>` with the existing
// provenance/ACR checks, the deployment sample is independently selectable and
// read-only, and staging and production advance their separate MCP overlay.
// Other environments keep the existing three-workload rollout boundary.
//
// This is a source/deterministic guard, not runtime proof. The staging Case
// owns container/protocol behavior and registry readback.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DOCKERFILE = 'Dockerfile.mcp.prebuilt';
const COMPOSE = 'deploy/docker-compose.mcp.yml';
const EXAMPLE = 'deploy/mcp.example.toml';
const STAGING = '.github/workflows/release-staging.yml';
const PRODUCTION = '.github/workflows/release-production.yml';
const ACR = '.github/workflows/deploy-staging-acr.yml';
const VERIFIER = 'scripts/ci/verify-staging-ghcr-source.mjs';
const MIRROR = 'scripts/mirror-container-images.sh';
const GITOPS = 'scripts/gitops-commit.sh';
const SEAL = '.github/workflows/deploy-seal-gitops-secret.yml';
const DEV_COMPOSE = 'deploy/docker-compose.yml';
const DOCS = 'docs/architecture/mcp.md';

const SOURCES = [
  DOCKERFILE, COMPOSE, EXAMPLE, STAGING, PRODUCTION, ACR,
  VERIFIER, MIRROR, GITOPS, SEAL, DEV_COMPOSE, DOCS,
];

export function loadSources(root = ROOT) {
  const files = new Map();
  for (const file of SOURCES) {
    files.set(file, fs.readFileSync(path.join(root, file), 'utf8'));
  }
  return files;
}

function replaceOnce(text, needle, replacement) {
  const at = text.indexOf(needle);
  assert.notEqual(at, -1, 'fixture source is missing: ' + needle);
  return text.slice(0, at) + replacement + text.slice(at + needle.length);
}

function executableText(dockerfile) {
  // Forbidden-payload checks apply to instructions, not explanatory comments.
  return dockerfile
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

export function checkSources(files) {
  const errors = [];
  const text = (file) => files.get(file) ?? '';
  const includes = (file, fragments) => {
    const body = text(file);
    for (const fragment of fragments) {
      if (!body.includes(fragment)) errors.push(file + ': missing ' + fragment);
    }
  };
  const count = (file, fragment) =>
    text(file).split(fragment).length - 1;
  const rejects = (file, pattern, message) => {
    if (pattern.test(text(file))) errors.push(file + ': ' + message);
  };

  // Dedicated artifact: exactly the prebuilt host binary.
  includes(DOCKERFILE, [
    'FROM debian:bookworm-20261104-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc',
    'ca-certificates',
    'COPY --from=mcp-bin /nession-mcp /usr/local/bin/nession-mcp',
    'chmod +x /usr/local/bin/nession-mcp',
    'ARG TARGETARCH',
    'amd64) expected=3e00',
    'arm64) expected=b700',
    'test "$machine" = "$expected"',
    'ARG NESSION_SOURCE_REVISION',
    'USER 10001:10001',
    'EXPOSE 9090',
    'ENTRYPOINT ["/usr/local/bin/nession-mcp"]',
    'HEALTHCHECK',
  ]);
  const instructions = executableText(text(DOCKERFILE));
  for (const payload of ['nginx', 'tmux', 'erofs', 'bubblewrap', 'nodejs',
    'claude-code', 'web-dist', '/nession-server', '/nession-agent']) {
    if (instructions.toLowerCase().includes(payload.toLowerCase())) {
      errors.push(DOCKERFILE + ': must not carry Server/Agent/UI/toolchain payload ' + payload);
    }
  }
  if (/(AUTH|SERVER|AGENT|MCP)_TOKEN\s*=|auth_token/i.test(instructions)) {
    errors.push(DOCKERFILE + ': must not bake a credential or default token');
  }
  if (/HEALTHCHECK[\s\S]{0,240}\/mcp|HEALTHCHECK[\s\S]{0,240}Authorization/i.test(instructions)) {
    errors.push(DOCKERFILE + ': liveness probe must not call privileged MCP operations');
  }
  if (/\bVOLUME\b/.test(instructions)) {
    errors.push(DOCKERFILE + ': an OCI VOLUME is not a Secret/config mount');
  }

  // Independently selectable, read-only deployment sample.
  includes(COMPOSE, [
    'profiles: ["mcp"]',
    '${NESSION_MCP_IMAGE:?',
    'target: /etc/nession/mcp.toml',
    '${NESSION_MCP_CONFIG_FILE:?',
    'cap_drop:',
    'no-new-privileges:true',
  ]);
  if ((text(COMPOSE).match(/read_only: true/g) ?? []).length < 2 ||
      !/target: \/etc\/nession\/mcp\.toml[\s\S]{0,120}read_only: true/.test(text(COMPOSE))) {
    errors.push(COMPOSE + ': must mount the configuration and run read-only');
  }
  rejects(COMPOSE, /(AUTH|SERVER|AGENT)_TOKEN\s*:/,
    'sample must not embed an operator credential');
  includes(EXAMPLE, [
    '[mcp]',
    'listen_address = "0.0.0.0:9090"',
    'allowed_hosts = [',
    '[backend.server]',
    'endpoint = "wss://nession.example.com/ws"',
  ]);
  rejects(EXAMPLE, /auth_token\s*=\s*"[^"]+"/,
    'example must not carry a credential; non-empty values belong to the operator Secret');
  if ((text(EXAMPLE).match(/auth_token\s*=\s*""/g) ?? []).length < 2) {
    errors.push(EXAMPLE + ': both required credentials must default to empty fail-closed values');
  }

  // Staging: one source-pinned multi-arch release for the fourth role.
  includes(STAGING, [
    '--bin nession-server --bin nession-agent --bin nession-mcp',
    'name: mcp-bin-amd64',
    'name: mcp-bin-arm64',
    'docker-mcp-amd64:',
    'docker-mcp-arm64:',
    'mcp-${{ env.SHORT_SHA }}-amd64',
    'mcp-${{ env.SHORT_SHA }}-arm64',
    'mcp-bin=/tmp/mcp-bin',
    'for prefix in server agent mcp ui; do',
    'for role in agent mcp server ui; do',
  ]);
  if (count(STAGING, 'file: Dockerfile.mcp.prebuilt') !== 2) {
    errors.push(STAGING + ': must define the standalone MCP image for both architectures');
  }

  // Production: version-tagged publication, release notes and ACR mirror.
  includes(PRODUCTION, [
    '--bin nession-server --bin nession-agent --bin nession --bin nession-mcp',
    'name: mcp-bin-amd64',
    'name: mcp-bin-arm64',
    'docker-mcp-amd64:',
    'docker-mcp-arm64:',
    'mcp-${{ env.RUST_VER }}-amd64',
    'mcp-${{ env.RUST_VER }}-arm64',
    'for prefix in server agent mcp; do',
    'nession:mcp-${{ needs.version-check.outputs.rust_version }}',
    'image: [server, agent, mcp, ui]',
  ]);
  if (count(PRODUCTION, 'file: Dockerfile.mcp.prebuilt') !== 2) {
    errors.push(PRODUCTION + ': must build the standalone MCP image for both architectures');
  }

  // The independent ACR lane and its authenticated source verifier must
  // require the MCP artifact; a missing/failed MCP job cannot be accepted.
  includes(ACR, [
    'image: [server, agent, mcp, ui]',
    'keys == ["agent","mcp","server","ui"]',
    'for role in agent mcp server ui; do',
  ]);
  for (const job of ["'docker-mcp-amd64'", "'docker-mcp-arm64'"]) {
    if (!text(VERIFIER).includes(job)) {
      errors.push(VERIFIER + ': staging source verifier must require the MCP image job ' + job);
    }
  }
  includes(MIRROR, [
    'mcp) tags=("mcp-${runtime_version}")',
    '"mcp-${runtime_version}" "ui-${ui_version}"',
  ]);

  // Staging and production advance the fourth OCI role in a separate Argo
  // Application. Other environments must not acquire an implicit MCP workload.
  includes(GITOPS, [
    'if [[ "${env}" == "staging" || "${env}" == "production" ]]; then\n  for img in server agent ui mcp; do',
    'for img in server agent ui; do',
    'if [[ "${env}" == "staging" || "${env}" == "production" ]]; then\n  mcp_overlay="${tmp}/environments/${env}/mcp"',
    'if [[ ! -f "${mcp_overlay}/kustomization.yaml" ]]; then',
    '"ghcr.io/${OWNER}/nession-mcp=${TARGET_IMAGE}:mcp-${ref}"',
    'if [[ "$repair" == "--repair-current" ]]; then',
    'grep -Fxq "  newTag: ${role}-${ref}" kustomization.yaml',
    'git push origin gitops',
  ]);
  includes(PRODUCTION, [
    'repair-production:',
    'if: github.ref == \'refs/heads/main\'',
    'if: needs.version-check.outputs.version_changed == \'false\' && needs.version-check.outputs.repair_version != \'\'',
    'environment: production',
    'gh release view "v$VERSION" --json tagName,isDraft,isPrerelease',
    './scripts/gitops-commit.sh production "$VERSION" --repair-current',
  ]);
  includes(SEAL, [
    'newTag: mcp-',
    'docker buildx imagetools inspect --raw',
    'kubectl kustomize gitops/environments/production/mcp',
  ]);
  rejects(SEAL, /924b161/, 'production Secret rotation must not pin the pilot image');
  rejects(GITOPS, /for img in mcp; do/,
    'standalone MCP must not enter generic GitOps rollout');
  rejects(DEV_COMPOSE, /^\s*mcp:\s*$/m,
    'the Server/Agent dev stack must not auto-install the MCP service');

  // The canonical deployment documentation owns the operator contract.
  includes(DOCS, [
    '### Standalone OCI image (#3791)',
    'Dockerfile.mcp.prebuilt',
    'mcp-<short-sha>',
    'mcp-<workspace-version>',
    '/etc/nession/mcp.toml',
    'deploy/docker-compose.mcp.yml',
    '#3705',
  ]);

  return errors;
}

function selfTest(files) {
  const failures = checkSources(files).map((error) => 'baseline must pass: ' + error);
  const mutations = [
    ['MCP Dockerfile unpins audited Debian index', DOCKERFILE,
      (t) => replaceOnce(t, 'FROM debian:bookworm-20261104-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc', 'FROM debian:bookworm-slim'),
      'missing FROM debian:bookworm-20261104-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc'],
    ['Dockerfile loses the prebuilt binary', DOCKERFILE,
      (t) => replaceOnce(t, 'COPY --from=mcp-bin /nession-mcp /usr/local/bin/nession-mcp\n', ''),
      'missing COPY --from=mcp-bin /nession-mcp /usr/local/bin/nession-mcp'],
    ['Dockerfile loses the artifact executable bit', DOCKERFILE,
      (t) => replaceOnce(t, '    chmod +x /usr/local/bin/nession-mcp; \\\n', ''),
      'missing chmod +x /usr/local/bin/nession-mcp'],
    ['Dockerfile loses the ELF architecture probe', DOCKERFILE,
      (t) => replaceOnce(t, 'amd64) expected=3e00', 'amd64) expected=0000'),
      'missing amd64) expected=3e00'],
    ['Dockerfile gains an nginx payload', DOCKERFILE,
      (t) => t + '\nRUN apt-get install -y --no-install-recommends nginx\n',
      'must not carry Server/Agent/UI/toolchain payload nginx'],
    ['Dockerfile bakes a credential', DOCKERFILE,
      (t) => t + '\nENV MCP_AUTH_TOKEN=fixture\n',
      'must not bake a credential'],
    ['staging loses the arm64 MCP image job', STAGING,
      (t) => t.replace(/\n  docker-mcp-arm64:\n/, '\n  docker-mcp-arm64-disabled:\n'),
      'missing docker-mcp-arm64:'],
    ['staging merge omits the MCP index', STAGING,
      (t) => replaceOnce(t, 'for prefix in server agent mcp ui; do', 'for prefix in server agent ui; do'),
      'missing for prefix in server agent mcp ui; do'],
    ['production loses the MCP version manifest', PRODUCTION,
      (t) => replaceOnce(t, 'for prefix in server agent mcp; do', 'for prefix in server agent; do'),
      'missing for prefix in server agent mcp; do'],
    ['ACR lane omits the MCP mirror', ACR,
      (t) => replaceOnce(t, 'image: [server, agent, mcp, ui]', 'image: [server, agent, ui]'),
      'missing image: [server, agent, mcp, ui]'],
    ['source verifier drops the MCP jobs', VERIFIER,
      (t) => replaceOnce(t, "'docker-mcp-amd64', ", ''),
      'staging source verifier must require the MCP image job'],
    ['Compose config is writable', COMPOSE,
      (t) => t.replaceAll('read_only: true', 'read_only: false'),
      'must mount the configuration and run read-only'],
    ['example carries a real token', EXAMPLE,
      (t) => replaceOnce(t, 'auth_token = ""\n\n# The authorities', 'auth_token = "fixture-secret"\n\n# The authorities'),
      'example must not carry a credential'],
    ['Staging ACR verification drops MCP', GITOPS,
      (t) => replaceOnce(t, 'for img in server agent ui mcp; do', 'for img in server agent ui; do'),
      'missing if [[ "${env}" == "staging" || "${env}" == "production" ]]; then'],
    ['production MCP loses its guarded overlay', GITOPS,
      (t) => replaceOnce(t, 'if [[ "${env}" == "staging" || "${env}" == "production" ]]; then\n  mcp_overlay=', 'if [[ "${env}" == "staging" ]]; then\n  mcp_overlay='),
      'missing if [[ "${env}" == "staging" || "${env}" == "production" ]]; then'],
    ['production repair drops released-version check', PRODUCTION,
      (t) => replaceOnce(t, 'gh release view "v$VERSION" --json tagName,isDraft,isPrerelease', 'true'),
      'missing gh release view'],
    ['production repair drops core alignment check', GITOPS,
      (t) => replaceOnce(t, 'grep -Fxq "  newTag: ${role}-${ref}" kustomization.yaml', 'true'),
      'missing grep -Fxq'],
    ['Secret rotation hardcodes pilot SHA', SEAL,
      (t) => t + '\n# 924b161\n',
      'must not pin the pilot image'],
    ['Staging MCP loses its guarded overlay', GITOPS,
      (t) => replaceOnce(t, 'if [[ "${env}" == "staging" || "${env}" == "production" ]]; then\n  mcp_overlay=',
        'if true; then\n  mcp_overlay='),
      'missing if [[ "${env}" == "staging" || "${env}" == "production" ]]; then'],
    ['Staging MCP loses fail-closed overlay check', GITOPS,
      (t) => replaceOnce(t, 'if [[ ! -f "${mcp_overlay}/kustomization.yaml" ]]; then',
        'if [[ "${env}" == "unused" ]]; then'),
      'missing if [[ ! -f "${mcp_overlay}/kustomization.yaml" ]]; then'],
    ['Staging MCP loses source-pinned tag', GITOPS,
      (t) => replaceOnce(t, 'mcp-${ref}"', 'mcp-latest"'),
      'missing "ghcr.io/${OWNER}/nession-mcp=${TARGET_IMAGE}:mcp-${ref}"'],
    ['GitOps gains a generic MCP workload', GITOPS,
      (t) => t + '\nfor img in mcp; do :; done\n',
      'standalone MCP must not enter generic GitOps rollout'],
    ['docs lose the release tags', DOCS,
      (t) => t.replaceAll('mcp-<short-sha>', 'mcp-tag'),
      'missing mcp-<short-sha>'],
  ];
  for (const [name, file, mutate, expected] of mutations) {
    const mutated = new Map(files);
    try {
      mutated.set(file, mutate(files.get(file)));
    } catch (error) {
      failures.push(name + ': ' + error.message);
      continue;
    }
    const errors = checkSources(mutated);
    if (!errors.some((error) => error.startsWith(file + ':') && error.includes(expected))) {
      failures.push(name + ': mutation escaped the guard (expected "' + expected + '")');
    }
  }
  if (failures.length > 0) {
    process.stderr.write(failures.map((failure) => '[ERROR] ' + failure).join('\n') + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('mcp-standalone-image self-test: ' + mutations.length +
    ' negative mutations rejected\n');
}

const files = loadSources();
if (process.argv.includes('--self-test')) {
  selfTest(files);
} else {
  const errors = checkSources(files);
  if (errors.length > 0) {
    process.stderr.write(errors.map((error) => '[ERROR] ' + error).join('\n') + '\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('mcp-standalone-image: dedicated MCP image, source-pinned staging/' +
      'production publication, ACR provenance, independent read-only deployment and GitOps ' +
      'independence are consistent\n');
  }
}
