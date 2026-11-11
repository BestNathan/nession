#!/usr/bin/env node
// Canonical Docker Compose persistence guard for the EROFS runtime data (#3179).
//
// Invariant: the Compose Server's canonical data root (metadata DB, image blob
// store and build workspace derived from NESSION_HOME) and each Agent's
// distinct EROFS cache root are mounted on their own named volume. Every
// service declares its durable root explicitly; no two services share one.
// The unrelated ports/tokens/terminal variables are not inspected.
//
// The file is read relative to this script's repository checkout (the
// pre-commit runner exports a tree without `.git`), never the caller's cwd.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = 'deploy/docker-compose.yml';

export const SERVICES = {
  server: { home: '/data', volume: 'server-data', cache: null },
  agent: { home: '/data', volume: 'agent-data', cache: '/data/erofs' },
  'agent-remote': { home: '/data', volume: 'agent-remote-data', cache: '/data/erofs' },
};

const DEAD_SERVER_OVERRIDES = ['SERVER_DB_PATH', 'SERVER_IMAGE_BLOB_DIR', 'SERVER_IMAGE_BUILD_DIR'];

function stripComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trim();
}

function effectiveDefault(value) {
  const match = /^\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}$/.exec(value);
  return match ? match[1] : value;
}

function unquote(value) {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

/** Minimal parser for this repository-owned Compose shape. */
export function parseCompose(text) {
  const services = new Map();
  const topVolumes = new Set();
  let current = null;
  let section = null;
  let inTopVolumes = false;

  for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^ */)[0].length;
    const line = raw.trim();

    if (indent === 0) {
      current = null;
      section = null;
      inTopVolumes = line === 'volumes:';
      continue;
    }
    if (inTopVolumes) {
      if (indent === 2 && /^[a-z0-9_-]+:\s*$/.test(line)) {
        topVolumes.add(line.slice(0, -1));
      }
      continue;
    }
    if (indent === 2) {
      const match = /^([a-z0-9_-]+):\s*$/.exec(line);
      current = match ? { environment: new Map(), volumes: [] } : null;
      if (match) services.set(match[1], current);
      section = null;
      continue;
    }
    if (!current) continue;
    if (indent === 4) {
      section = line === 'environment:' ? 'environment' : line === 'volumes:' ? 'volumes' : null;
      continue;
    }
    if (indent >= 6 && section === 'environment') {
      const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (match) current.environment.set(match[1], unquote(stripComment(match[2])));
      continue;
    }
    if (indent >= 6 && section === 'volumes') {
      const match = /^-\s+(.*)$/.exec(line);
      if (match) current.volumes.push(unquote(stripComment(match[1])));
    }
  }
  return { services, topVolumes };
}

/** Check an explicit Compose text. Exported for the deterministic self-test. */
export function checkCompose(text) {
  const errors = [];
  const { services, topVolumes } = parseCompose(text);

  for (const [name, contract] of Object.entries(SERVICES)) {
    const service = services.get(name);
    if (!service) {
      errors.push(`${COMPOSE}: missing service \`${name}\``);
      continue;
    }
    if (service.environment.get('NESSION_HOME') !== contract.home) {
      errors.push(
        `${COMPOSE}: service \`${name}\` must set NESSION_HOME: "${contract.home}" (found ` +
        `${JSON.stringify(service.environment.get('NESSION_HOME'))})`,
      );
    }
    const mount = `${contract.volume}:${contract.home}`;
    if (!service.volumes.includes(mount)) {
      errors.push(
        `${COMPOSE}: service \`${name}\` must mount its named volume at the durable root: ` +
        `\`${mount}\``,
      );
    }
    if (contract.cache !== null) {
      const cache = service.environment.get('AGENT_EROFS_STORAGE_DIR');
      if (!cache || !effectiveDefault(cache).startsWith(`${contract.home}/`)) {
        errors.push(
          `${COMPOSE}: service \`${name}\` must set AGENT_EROFS_STORAGE_DIR under ` +
          `\`${contract.home}\` (found ${JSON.stringify(cache)})`,
        );
      }
    }
    // A service may only mount its own named volume for the durable root.
    for (const volume of service.volumes) {
      const target = volume.slice(volume.indexOf(':') + 1);
      if (target === contract.home && !volume.startsWith(`${contract.volume}:`)) {
        errors.push(
          `${COMPOSE}: service \`${name}\` must not reuse another service's volume at ` +
          `\`${contract.home}\` (found \`${volume}\`)`,
        );
      }
    }
  }

  const server = services.get('server');
  if (server) {
    for (const key of DEAD_SERVER_OVERRIDES) {
      if (server.environment.has(key)) {
        errors.push(
          `${COMPOSE}: \`${key}\` is not a supported Server path override; use NESSION_HOME ` +
          `with a matching volume`,
        );
      }
    }
  }

  const declared = new Set(Object.values(SERVICES).map((contract) => contract.volume));
  if (declared.size !== Object.values(SERVICES).length) {
    errors.push(`${COMPOSE}: each service needs a distinct named volume`);
  }
  for (const volume of declared) {
    if (!topVolumes.has(volume)) {
      errors.push(`${COMPOSE}: top-level \`volumes:\` must declare \`${volume}\``);
    }
  }

  return errors;
}

function loadCompose() {
  const file = path.join(ROOT, COMPOSE);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    process.stderr.write(`[ERROR] cannot read ${COMPOSE}: ${error.message}\n`);
    process.exitCode = 2;
    return null;
  }
}

function replaceOnce(text, needle, replacement) {
  if (!text.includes(needle)) throw new Error(`self-test mutation is stale: missing ${needle}`);
  return text.replace(needle, replacement);
}

function selfTest(text) {
  const baseline = checkCompose(text);
  const failures = baseline.map((error) => `baseline must pass: ${error}`);
  const mutations = [
    ['server loses its data root', (body) => replaceOnce(
      body,
      '      NESSION_HOME: "/data"\n', ''),
    'must set NESSION_HOME'],
    ['server volume leaves the root', (body) => replaceOnce(
      body,
      '- server-data:/data', '- server-data:/var/lib/nession'),
    'must mount its named volume at the durable root'],
    ['server reintroduces a dead path override', (body) => replaceOnce(
      body,
      '      SERVER_AUTH_TOKEN: "${SERVER_AUTH_TOKEN:-}"\n',
      '      SERVER_AUTH_TOKEN: "${SERVER_AUTH_TOKEN:-}"\n'
      + '      SERVER_DB_PATH: "/tmp/server.db"\n'),
    'not a supported Server path override'],
    ['agent loses its cache declaration', (body) => replaceOnce(
      body,
      '      AGENT_EROFS_STORAGE_DIR: "${AGENT_EROFS_STORAGE_DIR:-/data/erofs}"\n', ''),
    'must set AGENT_EROFS_STORAGE_DIR'],
    ['agent cache points outside the volume', (body) => replaceOnce(
      body,
      'AGENT_EROFS_STORAGE_DIR: "${AGENT_EROFS_STORAGE_DIR:-/data/erofs}"',
      'AGENT_EROFS_STORAGE_DIR: "/var/cache/erofs"'),
    'must set AGENT_EROFS_STORAGE_DIR under'],
    ['agent loses its volume', (body) => replaceOnce(
      body, '      - agent-data:/data\n', ''),
    'must mount its named volume at the durable root'],
    ['agent-remote reuses the agent volume', (body) => replaceOnce(
      body, '- agent-remote-data:/data', '- agent-data:/data'),
    'must not reuse another service\'s volume'],
    ['top-level agent-remote volume is undeclared', (body) => replaceOnce(
      body, '  agent-remote-data:\n', ''),
    'top-level `volumes:` must declare `agent-remote-data`'],
  ];

  for (const [name, mutate, expected] of mutations) {
    let mutated;
    try {
      mutated = mutate(text);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      continue;
    }
    if (!checkCompose(mutated).some((error) => error.includes(expected))) {
      failures.push(`${name}: mutation escaped the guard (expected "${expected}")`);
    }
  }

  if (failures.length > 0) {
    process.stderr.write(failures.map((failure) => `[ERROR] ${failure}`).join('\n') + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`compose-storage-contract self-test: ${mutations.length} negative mutations rejected\n`);
}

const text = loadCompose();
if (process.exitCode !== 2 && text !== null) {
  if (process.argv.includes('--self-test')) {
    selfTest(text);
  } else {
    const errors = checkCompose(text);
    if (errors.length > 0) {
      process.stderr.write(errors.map((error) => `[ERROR] ${error}`).join('\n') + '\n');
      process.exitCode = 1;
    } else {
      process.stdout.write(
        'compose-storage-contract: Server and both Agents use distinct named volumes at their ' +
        'declared durable roots\n',
      );
    }
  }
}
