'use strict';
// Shared exact-SHA steps for the #3358 recovery Cases.
//
// Each Case names its own tests and source invariants; this module only runs
// the canonical suites against the target checkout and reports concrete,
// credential-free evidence.
const fs = require('node:fs');
const path = require('node:path');
const { run, targetSha } = require('./control-mode-cases.cjs');
const { readSource, runWebTests } = require('./p2p-credential-cases.cjs');

const ROOT = path.resolve(__dirname, '../../..');

/** Fail unless every named source owner contains its invariant marker. */
function requireSource(entries) {
  for (const [relativePath, marker, label] of entries) {
    if (!readSource(relativePath).includes(marker)) {
      throw new Error('missing ' + label + ' (' + marker + ') in ' + relativePath);
    }
  }
}

/**
 * Fail if a source still contains something the criterion forbids.
 *
 * Used for negative properties such as "credentials never enter browser
 * persistence or diagnostic logs"; a positive test cannot prove an absence.
 */
function forbidSource(entries) {
  for (const [relativePath, marker, label] of entries) {
    if (readSource(relativePath).includes(marker)) {
      throw new Error('forbidden ' + label + ' (' + marker + ') in ' + relativePath);
    }
  }
}

/** The short P2P lease the acceptance Server actually rendered for this run. */
function renderedP2pLeaseSeconds() {
  const runtimeFile = process.env.NESSION_ACCEPTANCE_RUNTIME_FILE;
  if (!runtimeFile) {
    throw new Error('the acceptance runtime file is not set');
  }
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  const rendered = fs.readFileSync(
    path.join(runtime.home, 'runtime-config', 'server.toml'),
    'utf8',
  );
  const match = /^p2p_token_expiry_secs\s*=\s*(\d+)\s*$/m.exec(rendered);
  if (!match) {
    throw new Error('the acceptance Server config does not set p2p_token_expiry_secs');
  }
  const lease = Number(match[1]);
  if (!Number.isSafeInteger(lease) || lease < 1 || lease > 30) {
    throw new Error('the acceptance lease is not short enough for a deterministic TTL test: ' + lease);
  }
  return lease;
}

module.exports = {
  ROOT,
  forbidSource,
  readSource,
  renderedP2pLeaseSeconds,
  requireSource,
  run,
  runWebTests,
  targetSha,
};
