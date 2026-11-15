'use strict';
// #3439 SC-03 / W2 (Server): an upgraded Server socket has one absolute
// first-authentication deadline that frames cannot extend, and a separate
// pending-auth concurrency budget that a `server.auth` returns.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const DEADLINE =
  'websocket::a_server_socket_that_never_authenticates_closes_at_the_absolute_auth_deadline';
const BUDGET =
  'websocket::the_server_pending_auth_budget_refuses_an_upgrade_and_authentication_returns_it';

run(({ evidence }) => {
  const sha = targetSha();
  const deadline = crateTests(
    'nession-server',
    ['--test', 'integration', 'auth_deadline'],
    600_000,
  );
  assertRan(deadline, [DEADLINE]);
  const budget = crateTests(
    'nession-server',
    ['--test', 'integration', 'auth_budget'],
    600_000,
  );
  assertRan(budget, [BUDGET]);

  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': an upgraded Server socket closed at its absolute auth deadline despite continuous Ping ' +
      'frames; a second upgrade was refused 503 while the only pending-auth slot was held, and a ' +
      'successful server.auth returned the slot',
  });
  return (
    'Server upgraded sockets are bounded by an absolute PendingAuth deadline and a separate ' +
    'pending-auth concurrency budget'
  );
});
