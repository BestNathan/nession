'use strict';
// #2784 SC-01: an authenticated server.commands.list whose DAO read fails
// answers with a distinguishable failure — an empty list plus a generic error,
// never SQL details — while a healthy read returns the versioned success shape.
// Unauthorized requests still fail closed.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../../../..');
const TESTS = [
  'commands_list_reports_a_database_read_failure',
  'commands_list_valid_empty_list_is_not_a_failure',
  'commands_list_empty',
  'commands_list_requires_auth',
];

function targetSha() {
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA || '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('exact target SHA is required');
  if (!fs.existsSync(path.join(root, '.git'))) throw new Error('target checkout is not a git tree');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.status !== 0) throw new Error('cannot read the target checkout HEAD');
  if (String(head.stdout).trim() !== sha) {
    throw new Error('checkout HEAD is not the Acceptance target SHA');
  }
  return sha;
}

function run() {
  try {
    const sha = targetSha();
    const result = spawnSync(
      'cargo',
      ['test', '-p', 'nession-server', 'commands_list', '--', '--nocapture'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 100000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', RUSTC_WRAPPER: '' },
      },
    );
    if (result.error) throw result.error;
    const output = String(result.stdout) + '\n' + String(result.stderr);
    if (result.status !== 0) {
      throw new Error('server contract failed (exit ' + result.status + '): ' + output.slice(-4500));
    }
    for (const name of TESTS) {
      if (!output.includes(name + ' ... ok')) {
        throw new Error('missing concrete assertion: ' + name);
      }
    }
    process.stdout.write(JSON.stringify({
      status: 'pass',
      summary:
        'A controlled database read failure produces a distinguishable, generic command-list error; a healthy empty list and the auth refusal keep their own shapes',
      evidence: [{
        type: 'runtime',
        value:
          'exact SHA ' + sha + ': dropped quick_commands table made the authenticated ' +
          'handler answer commands=[] plus a non-SQL error that deserializes as the ' +
          'versioned contract; a healthy empty list carried no error; unauthorized ' +
          'requests still failed closed',
      }],
    }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      status: 'fail',
      summary: String(error && error.message ? error.message : error).slice(-4400),
      evidence: [{
        type: 'runtime',
        value: 'the exact-SHA commands-list handler contract did not establish the criterion',
      }],
    }) + '\n');
    process.exitCode = 1;
  }
}

run();
