#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const index = JSON.parse(fs.readFileSync(path.join(here, 'capabilities.json'), 'utf8'));

const stop = new Set([
  'a','an','and','are','as','at','be','by','for','from','in','is','it','of','on','or','the','to','with',
  'must','should','when','while','after','before','current','existing'
]);

function tokenize(input) {
  return [...new Set(
    input
      .toLowerCase()
      .replace(/[^a-z0-9:/._-]+/g, ' ')
      .split(/\s+/)
      .flatMap((t) => t.split(/[/:._-]+/))
      .filter((t) => t.length >= 2 && !stop.has(t))
  )];
}

function score(cap, query) {
  const tokens = tokenize(query);
  const id = cap.id.toLowerCase();
  const name = cap.name.toLowerCase();
  const description = cap.description.toLowerCase();
  const aliases = cap.aliases.join(' ').toLowerCase();
  const invariants = cap.invariants.join(' ').toLowerCase();
  let value = 0;
  for (const token of tokens) {
    if (id.includes(token)) value += 6;
    if (name.includes(token)) value += 5;
    if (aliases.includes(token)) value += 4;
    if (description.includes(token)) value += 2;
    if (invariants.includes(token)) value += 1;
  }
  if (query.toLowerCase() === id || query.toLowerCase() === name) value += 100;
  return value;
}

function compact(cap) {
  return {
    id: cap.id,
    name: cap.name,
    description: cap.description,
    owners: cap.owners,
    dependencies: cap.dependencies,
    consumers: cap.consumers,
    state: cap.state,
    invariants: cap.invariants,
    evidence: cap.evidence,
  };
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.log('Usage: node .ai-native/resolve.mjs <task text | capability id>');
  console.log('       node .ai-native/resolve.mjs --list');
  process.exit(0);
}

if (args[0] === '--list') {
  console.log(JSON.stringify(index.capabilities.map(compact), null, 2));
  process.exit(0);
}

const query = args.join(' ');
const exact = index.capabilities.find((c) => c.id === query || c.name === query);
if (exact) {
  console.log(JSON.stringify({ query, matches: [{ score: 100, ...compact(exact) }] }, null, 2));
  process.exit(0);
}

const matches = index.capabilities
  .map((cap) => ({ score: score(cap, query), cap }))
  .filter((x) => x.score > 0)
  .sort((a, b) => b.score - a.score || a.cap.id.localeCompare(b.cap.id))
  .slice(0, 5)
  .map(({ score, cap }) => ({ score, ...compact(cap) }));

console.log(JSON.stringify({ query, matches }, null, 2));
