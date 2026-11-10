#!/usr/bin/env node
// Canonical reader for a workflow's own `on.pull_request.paths` routing.
// The workflow YAML owns the policy; consumers interpret that exact text
// instead of maintaining a second path catalog that can drift from Actions.
import path from 'node:path';

// These three producers require PR events even when a two-parent integration
// has an empty net diff. Their trusted job-level selectors retain the costly
// execution scope; no other workflow may silently drop its paths filter.
const UNFILTERED_EXACT_HEAD_PR = new Set([
  'ci-quality.yml','acceptance-case-smoke.yml','e2e-tests.yml',
]);

// Return the exact GitHub PR trigger scope. An explicitly allowlisted
// unfiltered producer applies to every PR path, never Not Required; ordinary
// missing/empty filters continue to fail closed.
export function prPaths(source, workflowFile = null) {
  const lines = source.split(/\r?\n/);
  const start = lines.indexOf('  pull_request:');
  if (start < 0) throw Error('pull_request trigger missing');
  let end = start + 1;
  while (end < lines.length && (!lines[end] || lines[end].startsWith('    '))) end++;
  const group = lines.slice(start + 1, end);
  const i = group.findIndex((line) => line === '    paths:');
  if (i < 0) {
    if (!UNFILTERED_EXACT_HEAD_PR.has(workflowFile))
      throw Error('pull_request.paths missing outside trusted exact-head producer');
    if (!group.includes('    branches: [staging, main]') ||
        group.some(line => /^    paths-ignore:/.test(line)))
      throw Error('unfiltered exact-head PR producer lost its explicit branch/scope guard');
    return ['**']; // GitHub unfiltered PR events: every repository-relative path
  }
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
  // `**` is the special unfiltered GitHub PR trigger sentinel above.
  // Node's path.matchesGlob('dir/file','**') does not match nested paths.
  if (globs.length === 1 && globs[0] === '**') return true;
  return globs.some((pattern) => path.matchesGlob(file, pattern));
}

export function isApplicable(workflowSource, changedFiles, workflowFile = null) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    throw Error('changed file list is empty or invalid');
  }
  for (const file of changedFiles) {
    if (typeof file !== 'string' || !file.trim()) throw Error('invalid changed path');
  }
  const globs = prPaths(workflowSource, workflowFile);
  return changedFiles.some((file) => matchesAny(globs, file));
}
