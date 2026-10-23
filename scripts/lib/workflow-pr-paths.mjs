#!/usr/bin/env node
// Canonical reader for a workflow's own `on.pull_request.paths` routing.
// The workflow YAML owns the policy; consumers interpret that exact text
// instead of maintaining a second path catalog that can drift from Actions.
import path from 'node:path';

// Extract the `pull_request.paths` list from one workflow source. Fails
// closed: a missing/empty block is an error, never "everything applies" or
// "nothing applies".
export function prPaths(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.indexOf('  pull_request:');
  if (start < 0) throw Error('pull_request trigger missing');
  let end = start + 1;
  while (end < lines.length && (!lines[end] || lines[end].startsWith('    '))) end++;
  const group = lines.slice(start + 1, end);
  const i = group.findIndex((line) => line === '    paths:');
  if (i < 0) throw Error('pull_request.paths missing');
  const paths = [];
  for (let j = i + 1; j < group.length; j++) {
    const line = group[j];
    if (line.startsWith('      #') || !line.trim()) continue;
    if (!line.startsWith('      - ')) break;
    paths.push(line.slice(8).replace(/^['"]|['"]$/g, ''));
  }
  if (!paths.length) throw Error('empty pull_request.paths');
  return paths;
}

// Actions path filters match repository-relative paths. Node's matchesGlob is
// the checked-in interpreter for that convention; ci-trigger-scope-selftest
// pins this interpreter against the real workflow routing matrix.
export function matchesAny(globs, file) {
  return globs.some((pattern) => path.matchesGlob(file, pattern));
}

export function isApplicable(workflowSource, changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    throw Error('changed file list is empty or invalid');
  }
  for (const file of changedFiles) {
    if (typeof file !== 'string' || !file.trim()) throw Error('invalid changed path');
  }
  const globs = prPaths(workflowSource);
  return changedFiles.some((file) => matchesAny(globs, file));
}
