import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('./templates/', import.meta.url)));
const IDENTIFIER = /^[a-z][a-z0-9-]*$/;
const VARIABLE = /^[a-zA-Z_][a-zA-Z_0-9]*(?:\.[a-zA-Z_][a-zA-Z_0-9]*)*$/;

function source(relativePath, sources) {
  const file = path.resolve(ROOT, relativePath);
  if (!file.startsWith(ROOT + path.sep)) throw new Error('Prompt template escapes the template root');
  const content = fs.readFileSync(file, 'utf8');
  sources.set(relativePath, content);
  return content;
}

function valueOf(context, key) {
  let value = context;
  for (const part of key.split('.')) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) {
      throw new Error('Missing Prompt template variable: ' + key);
    }
    value = value[part];
  }
  if (value === undefined || value === null) throw new Error('Missing Prompt template variable: ' + key);
  if (typeof value === 'object') throw new Error('Prompt template variable must be a scalar: ' + key);
  return String(value);
}

function expand(text, context, sources, stack = []) {
  let result = text.replace(/\{\{\s*>\s*([a-z0-9-]+(?:\/[a-z0-9-]+)*)\s*\}\}/g, (_, name) => {
    const relative = 'shared/' + name + '.hbs';
    if (stack.includes(relative)) throw new Error('Cyclic Prompt partial: ' + [...stack, relative].join(' -> '));
    return expand(source(relative, sources), context, sources, [...stack, relative]);
  });
  result = result.replace(/\{\{\{\s*([^{}]+?)\s*\}\}\}|\{\{\s*([^{}]+?)\s*\}\}/g, (_, rawKey, key) => {
    const name = (rawKey || key).trim();
    if (!VARIABLE.test(name)) throw new Error('Unsupported Prompt template syntax: ' + name);
    return valueOf(context, name);
  });
  return result;
}

export function renderAgentPrompt({ id, version, context }) {
  if (!IDENTIFIER.test(id) || !/^v[1-9][0-9]*$/.test(version)) {
    throw new Error('Invalid Prompt template ID or version');
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('Prompt context must be an object');
  }
  const sources = new Map();
  const root = id + '/' + version + '/';
  const system = expand(source(root + 'system.hbs', sources), context, sources).trim();
  const task = expand(source(root + 'task.hbs', sources), context, sources).trim();
  const digest = crypto.createHash('sha256');
  for (const [name, content] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    digest.update(name + '\0' + content + '\0');
  }
  return {
    template_id: id,
    template_version: version,
    template_sha256: digest.digest('hex'),
    messages: [{ role: 'system', content: system }, { role: 'user', content: task }],
    text: system + '\n\n' + task,
  };
}