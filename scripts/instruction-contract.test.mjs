import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateInstructionTree } from './instruction-contract.mjs';

const scopes = ['web', 'crates/nession-protocol', 'crates/nession-agent', 'scripts', '.github', 'design', 'docs'];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-instruction-contract-'));
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.githooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Root\n\n[demo](.claude/skills/demo/SKILL.md)\n');
  fs.writeFileSync(path.join(root, '.githooks', 'pre-commit'), '#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n');
  fs.symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'));
  fs.symlinkSync('../.claude/skills', path.join(root, '.agents', 'skills'));
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo workflow.\n---\n\n# Demo\n');
  for (const scope of scopes) {
    const dir = path.join(root, scope);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Scope\n');
    fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'));
  }
  return root;
}

test('accepts canonical instruction layout', () => {
  const root = fixture();
  try { assert.deepEqual(validateInstructionTree(root).errors, []); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects editable CLAUDE copy', () => {
  const root = fixture();
  try {
    fs.unlinkSync(path.join(root, 'CLAUDE.md'));
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# copy\n');
    assert.ok(validateInstructionTree(root).errors.some((x) => x.includes('must be a symlink')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects oversized root and Skill entrypoints', () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), `${'x\n'.repeat(205)}`);
    fs.writeFileSync(path.join(root, '.claude', 'skills', 'demo', 'SKILL.md'), `---\nname: demo\ndescription: Demo.\n---\n${'x\n'.repeat(330)}`);
    const errors = validateInstructionTree(root).errors;
    assert.ok(errors.some((x) => x.includes('always-on budget')));
    assert.ok(errors.some((x) => x.includes('entrypoint budget')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects broken compatibility links', () => {
  const root = fixture();
  try {
    fs.unlinkSync(path.join(root, 'web', 'CLAUDE.md'));
    fs.symlinkSync('../wrong', path.join(root, 'web', 'CLAUDE.md'));
    fs.unlinkSync(path.join(root, '.agents', 'skills'));
    fs.symlinkSync('../missing', path.join(root, '.agents', 'skills'));
    const errors = validateInstructionTree(root).errors;
    assert.ok(errors.some((x) => x.includes('web/CLAUDE.md')));
    assert.ok(errors.some((x) => x.includes('.agents/skills')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects duplicate names and broken relative links', () => {
  const root = fixture();
  try {
    const other = path.join(root, '.claude', 'skills', 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'SKILL.md'), '---\nname: demo\ndescription: Other.\n---\n\n[missing](./references/nope.md)\n');
    const errors = validateInstructionTree(root).errors;
    assert.ok(errors.some((x) => x.includes('duplicate Skill name')));
    assert.ok(errors.some((x) => x.includes('broken local link')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('rejects broken root and scoped instruction links', () => {
  const root = fixture();
  try {
    fs.appendFileSync(path.join(root, 'AGENTS.md'), '\n[missing-root](docs/nope.md)\n');
    fs.writeFileSync(path.join(root, 'web', 'AGENTS.md'), '# Scope\n\n[missing-scope](./nope.md)\n');
    const errors = validateInstructionTree(root).errors;
    assert.ok(errors.some((x) => x.includes('AGENTS.md: broken local link docs/nope.md')));
    assert.ok(errors.some((x) => x.includes('web/AGENTS.md: broken local link ./nope.md')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects malformed pre-commit router syntax', () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, '.githooks', 'pre-commit'), '#!/usr/bin/env bash\nif then\n');
    const errors = validateInstructionTree(root).errors;
    assert.ok(errors.some((x) => x.includes('.githooks/pre-commit: shell syntax invalid')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
