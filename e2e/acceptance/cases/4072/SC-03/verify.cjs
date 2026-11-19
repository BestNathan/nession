'use strict';
// #4072 SC-03: after a silent Server is replaced by a responsive one, the real
// Agent re-registers and normal heartbeat delivery resumes. A genuine explicit
// registration refusal stays permanent: it reaches the caller and is never
// retried.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

const RECOVERY =
  'connection::server_client::tests::connect_attempt_silent_server_is_retried_then_registers';
const REFUSAL =
  'connection::server_client::tests::connect_attempt_explicit_refusal_stays_permanent';

run(({ evidence }) => {
  const sha = targetSha();
  const recovery = crateTests(
    'nession-agent',
    ['--lib', 'connection::server_client::tests::connect_attempt_silent_server_is_retried'],
    300000,
    isolatedTmuxEnv('nession-4072-sc03-recovery'),
  );
  assertRan(recovery, [RECOVERY]);

  const refusal = crateTests(
    'nession-agent',
    ['--lib', 'connection::server_client::tests::connect_attempt_explicit_refusal_stays_permanent'],
    300000,
    isolatedTmuxEnv('nession-4072-sc03-refusal'),
  );
  assertRan(refusal, [REFUSAL]);

  evidence.push({
    type: 'runtime',
    value:
      'exact staging ' + sha + ': a real Agent retried a silent mock Server, registered with ' +
      'its responsive replacement, and delivered a normal heartbeat on the recovered ' +
      'connection; an explicit registration refusal reached connect_and_run with the Server ' +
      'reason and the supervisor never opened a second connection',
  });
  return 'Silent-Server recovery resumes registration/heartbeat; explicit refusal stays permanent';
});
