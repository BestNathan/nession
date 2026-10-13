'use strict';

// Canonical long-lived Playwright regression ID = filename stem.
// Scope deliberately excludes e2e/acceptance and e2e/scenarios.
const fs = require('node:fs');
const path = require('node:path');
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function discover(root) {
  const testRoot = path.resolve(root);
  if (!fs.existsSync(testRoot) || !fs.lstatSync(testRoot).isDirectory()) {
    throw new Error('E2E Tests root is missing: ' + testRoot);
  }
  const found = [];
  const ids = new Set();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('symlink in E2E Tests tree: ' + file);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.spec.ts')) continue;
      const id = entry.name.slice(0, -'.spec.ts'.length);
      if (!ID.test(id)) throw new Error('invalid E2E ID derived from spec filename: ' + entry.name);
      if (ids.has(id.toLowerCase())) throw new Error('duplicate E2E ID: ' + id);
      ids.add(id.toLowerCase());
      const relative = path.relative(path.dirname(testRoot), file).split(path.sep).join('/');
      found.push({ id, file: relative });
    }
  }
  walk(testRoot);
  if (!found.length) throw new Error('empty E2E Tests catalog');
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

function select(tests, ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('empty E2E ID selection');
  const registry = new Map(tests.map(test => [test.id, test]));
  const selected = [], seen = new Set();
  for (const id of ids) {
    if (!ID.test(id)) throw new Error('invalid E2E ID: ' + id);
    if (seen.has(id)) throw new Error('duplicate selected E2E ID: ' + id);
    seen.add(id);
    const test = registry.get(id);
    if (!test) throw new Error('unknown E2E ID: ' + id);
    selected.push(test);
  }
  return selected;
}

module.exports = { discover, select };
