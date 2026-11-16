'use strict';
// #3439 SC-03 / W2 (Agent): an upgraded P2P socket gets one absolute
// authentication deadline that frames cannot extend, and upgraded-pending-auth
// sockets have their own concurrency budget.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const DEADLINE =
  'server::websocket::tests::an_upgraded_socket_closes_at_the_absolute_auth_deadline_despite_frames';
const BUDGET =
  'server::websocket::tests::the_pending_auth_budget_refuses_an_upgrade_and_authentication_returns_it';

run(({ evidence }) => {
  const sha = targetSha();
  const deadline = crateTests(
    'nession-agent',
    ['--lib', 'absolute_auth_deadline'],
    600_000,
  );
  assertRan(deadline, [DEADLINE]);
  const budget = crateTests(
    'nession-agent',
    ['--lib', 'pending_auth_budget'],
    600_000,
  );
  assertRan(budget, [BUDGET]);

  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': an upgraded Agent P2P socket closed at its absolute auth deadline despite a refused ' +
      'authentication and continuous Ping frames; a second upgrade was refused 503 while the only ' +
      'pending-auth slot was held, and a successful client.auth returned the slot',
  });
  return (
    'Agent upgraded sockets are bounded by an absolute PendingAuth deadline and a separate ' +
    'pending-auth concurrency budget'
  );
});
