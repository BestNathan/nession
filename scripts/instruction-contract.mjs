#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const ROOT_MAX_LINES = 200;
const SKILL_MAX_LINES = 320;
const MAX_SKILL_NAME_LENGTH = 64;
const REQUIRED_SCOPES = ['web', 'crates/nession-protocol', 'crates/nession-agent', 'scripts', '.github', 'design', 'docs'];

function lineCount(text) {
  return text.replace(/\r\n?/g, '\n').split('\n').length;
}

function rel(root, file) {
  return path.relative(root, file) || '.';
}

function discoverInstructionPaths(root) {
  const git = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
  if (!git.error && git.status === 0) {
    return git.stdout
      .split('\0')
      .filter((file) => file && /(^|\/)(AGENTS|CLAUDE)\.md$/.test(file))
      .sort();
  }

  const found = [];
  const skippedNames = new Set(['.git', 'node_modules', 'target']);

  function walk(dir, relativeDir = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (skippedNames.has(entry.name) || relativePath === '.claude/worktrees' || relativePath.startsWith('.claude/worktrees/')) continue;
        walk(path.join(dir, entry.name), relativePath);
        continue;
      }
      if (entry.name === 'AGENTS.md' || entry.name === 'CLAUDE.md') found.push(relativePath);
    }
  }

  walk(root);
  return found.sort();
}

function discoverInstructionScopes(instructionPaths) {
  return [...new Set(
    instructionPaths
      .map((file) => path.posix.dirname(file))
      .filter((dir) => dir !== '.'),
  )].sort();
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

function parseStrictFrontmatterScalar(raw, file, key, errors) {
  const value = raw.trim();
  if (!value) {
    errors.push(`${file}: frontmatter ${key} must be a non-empty string`);
    return null;
  }

  if (value.startsWith('"')) {
    if (!value.endsWith('"')) {
      errors.push(`${file}: frontmatter ${key} has invalid quoted YAML scalar`);
      return null;
    }
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'string' || !parsed.trim()) throw new Error('not string');
      return parsed;
    } catch {
      errors.push(`${file}: frontmatter ${key} has invalid quoted YAML scalar`);
      return null;
    }
  }

  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) {
      errors.push(`${file}: frontmatter ${key} has invalid quoted YAML scalar`);
      return null;
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }

  // Deliberately strict YAML subset: single-line plain string scalars only.
  // Reject flow/block/tag/anchor forms and values YAML would type as
  // mappings/comments/booleans/nulls/numbers. Nession Skill frontmatter
  // intentionally needs only name + description strings.
  const forbiddenStart = ['[', ']', '{', '}', '|', '>', '&', '*', '!', '?', '@', '`'];
  if (
    forbiddenStart.includes(value[0]) ||
    value.includes(': ') ||
    value.includes(' #') ||
    /^(?:null|~|true|false|yes|no|on|off)$/i.test(value) ||
    /^[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[-+]?[0-9]+)?$/i.test(value)
  ) {
    errors.push(`${file}: frontmatter ${key} is outside the supported YAML string subset`);
    return null;
  }

  return value;
}

function parseFrontmatter(text, file, errors) {
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    errors.push(`${file}: missing YAML frontmatter`);
    return null;
  }

  const fields = new Map();
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]+(.+)$/);
    if (!field) {
      errors.push(`${file}: frontmatter is not valid Nession YAML subset: ${line}`);
      return null;
    }

    const key = field[1];
    const rawValue = field[2];
    if (fields.has(key)) {
      errors.push(`${file}: duplicate frontmatter key ${key}`);
      return null;
    }
    fields.set(key, parseStrictFrontmatterScalar(rawValue, file, key, errors));
  }

  const name = fields.get('name');
  const description = fields.get('description');
  if (!name) errors.push(`${file}: missing frontmatter name`);
  if (!description) errors.push(`${file}: missing frontmatter description`);

  for (const key of fields.keys()) {
    if (key !== 'name' && key !== 'description') {
      errors.push(`${file}: unsupported frontmatter key ${key}`);
    }
  }

  return { name, description };
}

function validateLocalLinks(root, sourceFile, text, errors) {
  const dir = path.dirname(sourceFile);
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split('#', 1)[0].split('?', 1)[0].trim();
    if (!target) continue;
    const resolved = path.resolve(dir, target);
    if (!fs.existsSync(resolved)) {
      errors.push(`${rel(root, sourceFile)}: broken local link ${target}`);
    }
  }
}

function validateBashSyntax(root, relativePath, errors) {
  const file = path.join(root, relativePath);
  if (!fs.existsSync(file)) {
    errors.push(`${relativePath}: missing routed shell entrypoint`);
    return;
  }
  const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  if (result.error) {
    errors.push(`${relativePath}: could not run bash syntax check: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().replace(/\s+/g, ' ');
    errors.push(`${relativePath}: shell syntax invalid${detail ? `: ${detail}` : ''}`);
  }
}

function validatePreCommitInstructionRouter(root, errors) {
  const relativePath = '.githooks/pre-commit';
  const file = path.join(root, relativePath);
  if (!fs.existsSync(file)) return;

  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('STAGED_ALL=$(git diff --cached --name-only)')) {
    errors.push(`${relativePath}: STAGED_ALL must include staged deletions, renames, and type changes (no ACM-only diff filter)`);
  }
  if (!text.includes('STAGED_INSTRUCTIONS=')) {
    errors.push(`${relativePath}: missing instruction-surface routing`);
  }
  if (!text.includes('./gates/run instruction-contract')) {
    errors.push(`${relativePath}: instruction changes must invoke instruction-contract`);
  }
}

export function validateInstructionTree(root = DEFAULT_ROOT) {
  const errors = [];
  const rootAgents = path.join(root, 'AGENTS.md');

  if (!fs.existsSync(rootAgents)) {
    errors.push('AGENTS.md: missing canonical root instructions');
  } else {
    const rootText = fs.readFileSync(rootAgents, 'utf8');
    const count = lineCount(rootText);
    if (count > ROOT_MAX_LINES) {
      errors.push(`AGENTS.md: ${count} lines exceeds ${ROOT_MAX_LINES}-line always-on budget`);
    }
    validateLocalLinks(root, rootAgents, rootText, errors);
  }

  expectSymlink(errors, root, 'CLAUDE.md', 'AGENTS.md');
  expectSymlink(errors, root, '.agents/skills', '../.claude/skills');

  const instructionPaths = discoverInstructionPaths(root);
  const instructionPathSet = new Set(instructionPaths);
  const discoveredScopes = discoverInstructionScopes(instructionPaths);

  for (const scope of REQUIRED_SCOPES) {
    if (!discoveredScopes.includes(scope)) {
      errors.push(`${scope}/AGENTS.md: missing required scoped owner`);
    }
  }

  for (const scope of discoveredScopes) {
    const agentsRelative = `${scope}/AGENTS.md`;
    const claudeRelative = `${scope}/CLAUDE.md`;
    const hasAgents = instructionPathSet.has(agentsRelative);
    const hasClaude = instructionPathSet.has(claudeRelative);

    if (!hasAgents) {
      errors.push(`${scope}: scoped CLAUDE.md exists without canonical AGENTS.md`);
      continue;
    }

    const agentsPath = path.join(root, agentsRelative);
    if (fs.lstatSync(agentsPath).isSymbolicLink()) {
      errors.push(`${agentsRelative}: must be canonical, not a symlink`);
    } else {
      validateLocalLinks(root, agentsPath, fs.readFileSync(agentsPath, 'utf8'), errors);
    }

    if (!hasClaude) {
      errors.push(`${claudeRelative}: missing compatibility symlink`);
    } else {
      expectSymlink(errors, root, claudeRelative, 'AGENTS.md');
    }
  }

  validateBashSyntax(root, '.githooks/pre-commit', errors);
  validatePreCommitInstructionRouter(root, errors);

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
        if (meta.name.length > MAX_SKILL_NAME_LENGTH) {
          errors.push(`${rel(root, skillFile)}: Skill name exceeds Codex ${MAX_SKILL_NAME_LENGTH}-character limit`);
        }
        if (meta.name !== entry.name) {
          errors.push(`${rel(root, skillFile)}: frontmatter name must match directory name ${entry.name}`);
        }
      }
      validateLocalLinks(root, skillFile, text, errors);
    }
  }

  return { ok: errors.length === 0, errors, rootMaxLines: ROOT_MAX_LINES, skillMaxLines: SKILL_MAX_LINES, maxSkillNameLength: MAX_SKILL_NAME_LENGTH, scopes: discoveredScopes };
}

function main() {
  const result = validateInstructionTree();
  if (result.ok) {
    console.log(`instruction-contract: PASS (root<=${ROOT_MAX_LINES}, skills<=${SKILL_MAX_LINES}, name<=${MAX_SKILL_NAME_LENGTH}, dynamic scoped owners)`);
    return;
  }
  console.error('instruction-contract: FAIL');
  for (const error of result.errors) console.error(`- ${error}`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
