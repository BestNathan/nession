'use strict';
// #2803 SC-01: with agent-a:dev already sampled, switching to agent-b:dev —
// the same Session name on another Agent — shows no Agent A rows, inspector or
// snapshot header under B in the offline, rejecting and pending variants; a
// late A response cannot repopulate B. The render-frame assertions prove the
// interval before effects run is already identity-clean.
const { run, targetSha, webVitest } = require('../../../shared/web-vitest-cases.cjs');

const FILE = 'src/product/agent/hooks/__tests__/integration/useAgentProcesses.identity.test.tsx';
const TESTS = [
  'SC-01: switching to another Agent with the same Session name renders no previous rows when the Agent is offline',
  'SC-01: switching to another Agent with the same Session name renders no previous rows when the read rejects',
  'SC-01: switching to another Agent with the same Session name stays pending without the previous rows',
  'SC-01: a late response for the previous Agent cannot repopulate the new Session',
  'SC-01: the first render frame with the new Session identity carries no previous snapshot',
  'SC-01: the first render frame with the new Session identity carries no previous error',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitest(FILE, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': with agent-a:dev already sampled, switching the ' +
      'mounted Agent capability to agent-b:dev (same name, offline/rejecting/' +
      'pending) rendered none of A\'s process rows, inspector or snapshot header ' +
      'under B, and a late A response did not repopulate B',
  });
  return 'A process snapshot is bound to the full agent_id:session_name identity, so the same Session name on another Agent never inherits it';
});
