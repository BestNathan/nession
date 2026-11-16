#!/usr/bin/env node
// #3705: container-only MCP defaults, credential fail-closed, rollback,
// entrypoint wiring and four-variant package parity. No Docker/production
// credentials are required for these deterministic negative fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-3705-image-'));
const token = 'test-server-secret-never-in-logs';
const envKeys = ['NESSION_MCP_ENABLED', 'SERVER_AUTH_TOKEN', 'NESSION_HOME'];
const cleanEnv = { ...process.env };
for (const key of envKeys) delete cleanEnv[key];

function shell(script, args = [], overrides = {}) {
  return spawnSync('sh', [path.join(root, script), ...args], {
    encoding: 'utf8',
    timeout: 15000,
    cwd: root,
    env: { ...cleanEnv, ...overrides },
  });
}
function ok(result, context) {
  assert.equal(result.status, 0, context + ': ' + result.stderr);
  assert.equal(result.stdout.includes(token), false, context + ': stdout leaked secret');
  assert.equal(result.stderr.includes(token), false, context + ': stderr leaked secret');
}
function refused(result, expected, context) {
  assert.notEqual(result.status, 0, context + ': incorrectly succeeded');
  assert.match(result.stderr, expected, context);
  assert.equal(result.stderr.includes(token), false, context + ': leaked secret');
}
function includes(text, fragments, context) {
  for (const fragment of fragments) assert.ok(text.includes(fragment), context + ': missing ' + fragment);
}
function source(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }
function renderServer(name, overrides) {
  const dest = path.join(dir, name);
  const result = shell('deploy/render-server-config.sh', [dest], overrides);
  return { result, dest, output: fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '' };
}
try {
  // Renderer is invoked by both image entrypoints, not by native Rust config.
  const agent = shell('deploy/render-mcp-config.sh', ['agent']);
  ok(agent, 'Agent default');
  includes(agent.stdout, ['[mcp]', 'enabled = true', 'path = "/mcp"'], 'Agent default');
  const off = shell('deploy/render-mcp-config.sh', ['agent'], { NESSION_MCP_ENABLED: 'false' });
  ok(off, 'Agent opt-out');
  includes(off.stdout, ['enabled = false'], 'Agent opt-out');
  refused(shell('deploy/render-mcp-config.sh', ['agent'], {
    NESSION_MCP_ENABLED: '0',
  }), /NESSION_MCP_ENABLED/, 'invalid opt-out');

  const server = renderServer('server-on.toml', { SERVER_AUTH_TOKEN: token });
  ok(server.result, 'Server with token');
  includes(server.output, ['[mcp]', 'enabled = true', 'path = "/mcp"'], 'Server default');
  assert.equal((server.output.match(/\[mcp\]/g) || []).length, 1, 'exactly one MCP table');
  const missing = renderServer('server-no-token.toml', {});
  refused(missing.result, /SERVER_AUTH_TOKEN/, 'Server must reject anonymous MCP');
  const disabled = renderServer('server-off.toml', { NESSION_MCP_ENABLED: 'false' });
  ok(disabled.result, 'Server opt-out without token');
  includes(disabled.output, ['[mcp]', 'enabled = false'], 'Server opt-out');
  refused(renderServer('server-invalid.toml', {
    SERVER_AUTH_TOKEN: token, NESSION_MCP_ENABLED: 'yes',
  }).result, /NESSION_MCP_ENABLED/, 'invalid Server override');

  // Both embedded images use one config validator. Do not accidentally change
  // the Rust default, create a second MCP listener or synthesize a token.
  includes(source('crates/nession-common/src/config.rs'), [
    'enabled: false,', 'self.mcp.validate_for_host(&self.auth_token, "auth_token")',
  ], 'native host opt-in');
  includes(source('deploy/entrypoint-server.sh'), [
    'render-server-config.sh', 'nginx -t', 'location = /mcp',
    'proxy_pass https://', 'SERVER_BACKEND',
  ], 'Server entrypoint and TLS');
  includes(source('deploy/entrypoint-agent.sh'), [
    'render-mcp-config.sh" agent',
    'agent-config.toml', 'nginx -t',
  ], 'Agent entrypoint');
  const agentScript = source('deploy/entrypoint-agent.sh');
  assert.ok(
    agentScript.indexOf('render-mcp-config.sh" agent') <
      agentScript.indexOf('nginx -t'),
    'Agent configuration must precede nginx startup',
  );
  const serverScript = source('deploy/entrypoint-server.sh');
  assert.ok(
    serverScript.indexOf('render-server-config.sh') <
      serverScript.indexOf('nginx -t'),
    'Server token validation must precede nginx startup',
  );
  const nginx = source('deploy/nginx.conf.template');
  includes(nginx, [
    'location = /mcp', 'proxy_pass http://nession_backend;',
    'proxy_set_header Authorization $http_authorization;',
    'proxy_set_header MCP-Protocol-Version $http_mcp_protocol_version;',
    'proxy_set_header Mcp-Session-Id $http_mcp_session_id;',
    'proxy_set_header Origin $http_origin;', 'proxy_buffering off;',
  ], 'plain HTTP reverse proxy');
  includes(serverScript, [
    'proxy_set_header Authorization \\$http_authorization;',
    'proxy_set_header Origin \\$http_origin;',
    'proxy_buffering off;',
  ], 'HTTPS reverse proxy');
  for (const role of ['server', 'agent']) {
    for (const suffix of ['', '.prebuilt']) {
      const docker = source('Dockerfile.' + role + suffix);
      includes(docker, [
        'COPY deploy/render-mcp-config.sh /render-mcp-config.sh',
        'COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template',
        'COPY deploy/entrypoint-' + role + '.sh /entrypoint.sh',
        'render-mcp-config.sh',
      ], role + suffix + ' image path');
    }
  }
  const compose = source('deploy/docker-compose.yml');
  assert.equal(
    (compose.match(/NESSION_MCP_ENABLED: "\$\{NESSION_MCP_ENABLED:-true\}"/g) || []).length,
    3,
    'all three Compose services must use one opt-out',
  );
  for (const workflow of [
    '.github/workflows/release-staging.yml',
    '.github/workflows/release-production.yml',
  ]) {
    includes(source(workflow), ['Dockerfile.server.prebuilt', 'Dockerfile.agent.prebuilt'], workflow);
  }
  for (const script of [
    'deploy/render-server-config.sh', 'deploy/render-mcp-config.sh',
    'deploy/entrypoint-agent.sh', 'deploy/entrypoint-server.sh',
  ]) {
    const result = spawnSync('sh', ['-n', path.join(root, script)], { encoding: 'utf8' });
    ok(result, 'shell syntax ' + script);
  }
  console.log('MCP_IMAGE_CONFIG_TEST PASS: defaults, rollback, credentials, native opt-in, ingress and four image paths');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
