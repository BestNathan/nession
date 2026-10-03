#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const ROOT_MAX_LINES = 200;
const SKILL_MAX_LINES = 320;
const SCOPES = ['web', 'crates/nession-protocol', 'crates/nession-agent', 'scripts', '.github', 'design', 'docs'];

function lineCount(text) {
  return text.replace(/\r\n?/g, '\n').split('\n').length;
}

function rel(root, file) {
  return path.relative(root, file) || '.';
}

function expectSymlink(errors, root, file, expectedTarget) {
  const absolute = path.join(root, file);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    errors.push(`${file}: missing compatibility symlink`);
    return;
  }
  if (!stat.isSymbolicLink()) {
    errors.push(`${file}: must be a symlink, not an editable copy`);
    return;
  }
  const target = fs.readlinkSync(absolute);
  if (target !== expectedTarget) {
    errors.push(`${file}: expected symlink target ${expectedTarget}, got ${target}`);
  }
}

function parseFrontmatter(text, file, errors) {
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    errors.push(`${file}: missing YAML frontmatter`);
    return null;
  }
  const name = match[1].match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim();
  const description = match[1].match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim();
  if (!name) errors.push(`${file}: missing frontmatter name`);
  if (!description) errors.push(`${file}: missing frontmatter description`);
  return { name, description };
}

function validateLocalLinks(root, skillFile, text, errors) {
  const dir = path.dirname(skillFile);
  for (const match of text.matchAll(/\[[^\]]*\]\((\.\.?\/[^)#]+)(?:#[^)]+)?\)/g)) {
    const resolved = path.resolve(dir, match[1]);
    if (!fs.existsSync(resolved)) {
      errors.push(`${rel(root, skillFile)}: broken local link ${match[1]}`);
    }
  }
}

export function validateInstructionTree(root = DEFAULT_ROOT) {
  const errors = [];
  const rootAgents = path.join(root, 'AGENTS.md');

  if (!fs.existsSync(rootAgents)) {
    errors.push('AGENTS.md: missing canonical root instructions');
  } else {
    const count = lineCount(fs.readFileSync(rootAgents, 'utf8'));
    if (count > ROOT_MAX_LINES) {
      errors.push(`AGENTS.md: ${count} lines exceeds ${ROOT_MAX_LINES}-line always-on budget`);
    }
  }

  expectSymlink(errors, root, 'CLAUDE.md', 'AGENTS.md');
  expectSymlink(errors, root, '.agents/skills', '../.claude/skills');

  for (const scope of SCOPES) {
    const agentsPath = path.join(root, scope, 'AGENTS.md');
    if (!fs.existsSync(agentsPath)) {
      errors.push(`${scope}/AGENTS.md: missing scoped owner`);
      continue;
    }
    if (fs.lstatSync(agentsPath).isSymbolicLink()) {
      errors.push(`${scope}/AGENTS.md: must be canonical, not a symlink`);
    }
    expectSymlink(errors, root, `${scope}/CLAUDE.md`, 'AGENTS.md');
  }

  const skillsRoot = path.join(root, '.claude', 'skills');
  if (!fs.existsSync(skillsRoot)) {
    errors.push('.claude/skills: missing canonical Skill content root');
  } else {
    const names = new Map();
    const dirs = fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of dirs) {
      const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) {
        errors.push(`.claude/skills/${entry.name}: missing SKILL.md`);
        continue;
      }

      const text = fs.readFileSync(skillFile, 'utf8');
      const count = lineCount(text);
      if (count > SKILL_MAX_LINES) {
        errors.push(`.claude/skills/${entry.name}/SKILL.md: ${count} lines exceeds ${SKILL_MAX_LINES}-line entrypoint budget`);
      }

      const meta = parseFrontmatter(text, rel(root, skillFile), errors);
      if (meta?.name) {
        if (names.has(meta.name)) {
          errors.push(`duplicate Skill name ${meta.name}: ${names.get(meta.name)} and ${rel(root, skillFile)}`);
        } else {
          names.set(meta.name, rel(root, skillFile));
        }
        if (meta.name !== entry.name) {
          errors.push(`${rel(root, skillFile)}: frontmatter name must match directory name ${entry.name}`);
        }
      }
      validateLocalLinks(root, skillFile, text, errors);
    }
  }

  return { ok: errors.length === 0, errors, rootMaxLines: ROOT_MAX_LINES, skillMaxLines: SKILL_MAX_LINES, scopes: [...SCOPES] };
}

function main() {
  const result = validateInstructionTree();
  if (result.ok) {
    console.log(`instruction-contract: PASS (root<=${ROOT_MAX_LINES}, skills<=${SKILL_MAX_LINES}, ${SCOPES.length} scoped owners)`);
    return;
  }
  console.error('instruction-contract: FAIL');
  for (const error of result.errors) console.error(`- ${error}`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
