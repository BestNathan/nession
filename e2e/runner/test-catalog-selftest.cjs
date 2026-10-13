'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discover, select, verifyDiscoveredFiles } = require('./test-catalog.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-e2e-test-catalog-'));
try {
  const root = path.join(tmp, 'tests');
  fs.mkdirSync(path.join(root, 'browser'), { recursive: true });
  fs.mkdirSync(path.join(root, 'protocol'), { recursive: true });
  const write = (p, content = 'test("fixture", () => {});') => fs.writeFileSync(path.join(root, p), content);
  write('browser/terminal-attach.spec.ts');
  write('protocol/terminal-replay.spec.ts');
  const catalog = discover(root);
  assert.deepEqual(catalog.map(t => t.id), ['terminal-attach', 'terminal-replay']);
  assert.deepEqual(select(catalog, ['terminal-replay']).map(t => t.file), ['tests/protocol/terminal-replay.spec.ts']);
  assert.equal(select(catalog, ['terminal-attach', 'terminal-replay']).length, 2);
  for (const ids of [[], ['missing'], ['terminal-attach', 'terminal-attach'], ['../escape'], ['']]) {
    assert.throws(() => select(catalog, ids));
  }
  assert.equal(verifyDiscoveredFiles(catalog, [
    'tests/browser/terminal-attach.spec.ts', 'tests/protocol/terminal-replay.spec.ts',
  ]), 2);
  assert.throws(() => verifyDiscoveredFiles(catalog, ['tests/browser/terminal-attach.spec.ts']), /omitted/);
  assert.throws(() => verifyDiscoveredFiles(catalog, [
    'tests/browser/terminal-attach.spec.ts', 'tests/protocol/terminal-replay.spec.ts',
    'tests/browser/unregistered.spec.ts',
  ]), /unregistered/);
  assert.throws(() => verifyDiscoveredFiles(catalog, []), /no runnable/);
  write('protocol/terminal-attach.spec.ts');
  assert.throws(() => discover(root), /duplicate/);
  fs.unlinkSync(path.join(root, 'protocol/terminal-attach.spec.ts'));
  write('protocol/Bad_Name.spec.ts');
  assert.throws(() => discover(root), /invalid E2E ID/);
  fs.unlinkSync(path.join(root, 'protocol/Bad_Name.spec.ts'));
  fs.symlinkSync(path.join(root, 'browser/terminal-attach.spec.ts'), path.join(root, 'protocol', 'alias.spec.ts'));
  assert.throws(() => discover(root), /symlink/);
  fs.unlinkSync(path.join(root, 'protocol/alias.spec.ts'));
  fs.unlinkSync(path.join(root, 'browser/terminal-attach.spec.ts'));
  fs.unlinkSync(path.join(root, 'protocol/terminal-replay.spec.ts'));
  assert.throws(() => discover(root), /empty/);
  console.log('E2E Tests file-ID catalog: positive, collision, unsafe path and empty negative fixtures passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
