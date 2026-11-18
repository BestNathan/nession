'use strict';
// Shared machinery for the #3779 real-CLI Cases (SC-01…SC-03).
//
// The deterministic fixtures prove the typed negative paths. The positive path
// named by SCN-03 needs an actual, authenticated interactive Claude CLI in a
// Nession Session; the Acceptance / Cases runner provides neither a Claude
// install nor provider credentials. These helpers measure that prerequisite
// instead of claiming a runtime proof the runner did not perform, so the
// criterion stays Pending (never Pass by fixture substitution).
const { spawnSync } = require('node:child_process');
const { pending } = require('./sandbox-cases.cjs');

/// CLI versions whose `agents --json` shape has a captured fixture (#3779 P0).
/// This is evidence for the parser fixtures, not an admission gate: the product
/// attempts the command on every version and reports Unsupported/CannotObserve
/// from the answer.
const CAPTURED_CLI_VERSIONS = ['2.1.326'];

/// The `claude` version this runner exposes, or `null` when it cannot be run.
function probeClaudeVersion(env = {}) {
  const result = spawnSync('claude', ['--version'], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ...env },
  });
  if (result.error || result.status !== 0) return null;
  const first = String(result.stdout || '').trim().split('\n')[0].trim();
  return first || null;
}

/// Emit an honest Pending result: the deterministic fixtures passed, but the
/// live-CLI positive path was not executed on this runner.
function pendingRealCli(evidence, detail) {
  const version = probeClaudeVersion();
  evidence.push({
    type: 'blocked',
    value: 'The Acceptance / Cases runner provides no authenticated interactive Claude runtime: ' +
      'measured ' + (version ? '`' + version + '`' : 'no runnable `claude` executable') +
      '; the captured shape fixture is ' + CAPTURED_CLI_VERSIONS.join(', ') +
      ' (not an admission gate). ' + detail,
  });
  pending(
    'The real-CLI positive path stays Pending on this runner (' +
      (version ? version : 'claude absent') + '); deterministic negative-path fixtures passed. ' +
      detail,
    evidence,
  );
}

module.exports = { CAPTURED_CLI_VERSIONS, probeClaudeVersion, pendingRealCli };
