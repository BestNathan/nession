#!/usr/bin/env node
// #4241: deterministic, credential-free selector for orphan toolchains PR candidates.
// Script path and target semantics are delegated to the existing catalog-plan.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const selector = join(dirname(fileURLToPath(import.meta.url)), 'catalog-plan.mjs');
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;
const safe = value => NAME.test(value) && !value.includes('..');
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function catalog(path) {
  const root = resolve(path);
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw Error('candidate catalog must be an existing real directory');
  const result = new Map();
  for (const tool of readdirSync(root, { withFileTypes: true })) {
    if (tool.name === '.git' || tool.name === '.github') continue;
    if (tool.isSymbolicLink()) throw Error('unsafe tool directory symlink: ' + tool.name);
    if (!tool.isDirectory()) continue;
    if (!safe(tool.name)) throw Error('invalid tool selector: ' + tool.name);
    for (const version of readdirSync(join(root, tool.name), { withFileTypes: true })) {
      if (version.isSymbolicLink() || !version.isDirectory() || !safe(version.name))
        throw Error('invalid version directory: ' + tool.name + '/' + version.name);
      const name = tool.name + '/' + version.name;
      const script = join(root, name, 'build.sh');
      if (!existsSync(script) || !lstatSync(script).isFile() || lstatSync(script).isSymbolicLink())
        throw Error('missing regular build.sh: ' + name);
      result.set(name, digest(script));
    }
  }
  return result;
}

function plan(base, candidate) {
  const old = catalog(base);
  const current = catalog(candidate);
  const items = [];
  for (const name of [...current.keys()].sort()) {
    if (old.get(name) === current.get(name)) continue;
    const [tool, version] = name.split('/');
    const result = JSON.parse(execFileSync(process.execPath,
      [selector, 'targets', resolve(candidate), tool, version], {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4096,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent' },
      }));
    for (const target of result.targets) {
      if (target.platform !== 'linux' || !['amd64', 'arm64'].includes(target.arch))
        throw Error('unexpected native candidate target: ' + name);
      items.push({ tool, version, platform: target.platform, arch: target.arch });
    }
  }
  if (items.length > 80) throw Error('unbounded native toolchain candidate matrix');
  return { include: items };
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'nession-toolchain-candidate-'));
  try {
    const old = join(root, 'old');
    const candidate = join(root, 'candidate');
    mkdirSync(join(old, 'gh', '1.0'), { recursive: true });
    mkdirSync(join(candidate, 'gh', '1.0'), { recursive: true });
    const oldScript = join(old, 'gh', '1.0', 'build.sh');
    const currentScript = join(candidate, 'gh', '1.0', 'build.sh');
    const script = '#!/bin/bash\nif [ "$1" = targets ]; then printf "linux/amd64\\nlinux/arm64\\n"; fi\n';
    writeFileSync(oldScript, script);
    writeFileSync(currentScript, script);
    assert.deepEqual(plan(old, candidate), { include: [] }, 'unchanged fingerprints skip');
    writeFileSync(currentScript, script + '# update\n');
    assert.deepEqual(plan(old, candidate).include.map(x => x.arch), ['amd64', 'arm64']);
    rmSync(currentScript);
    assert.throws(() => plan(old, candidate), /missing regular build.sh/);
    writeFileSync(currentScript, '#!/bin/bash\nif [ "$1" = targets ]; then printf "linux/amd64\\nlinux/amd64\\n"; fi\n');
    assert.throws(() => plan(old, candidate), 'duplicate targets must fail');
    writeFileSync(currentScript, '#!/bin/bash\nif [ "$1" = targets ]; then printf "darwin/amd64\\n"; fi\n');
    assert.throws(() => plan(old, candidate), 'unsupported targets must fail');
    mkdirSync(join(old, 'old', '1'), { recursive: true });
    writeFileSync(join(old, 'old', '1', 'build.sh'), script);
    assert.deepEqual(plan(old, old), { include: [] }, 'identical catalog never rebuilds');
    rmSync(join(old, 'old'), { recursive: true });
    writeFileSync(currentScript, script);
    assert.deepEqual(plan(old, candidate), { include: [] }, 'deletions do not republish');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log('toolchain candidate selector positive/negative fixtures: PASS');
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'self-test') selfTest();
else if (mode === 'plan' && args.length === 2) process.stdout.write(JSON.stringify(plan(...args)) + '\n');
else throw Error('usage: catalog-candidate.mjs self-test | plan BASE_CATALOG CANDIDATE_CATALOG');
