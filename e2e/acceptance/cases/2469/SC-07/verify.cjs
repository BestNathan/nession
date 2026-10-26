'use strict';
// #2469 SC-07: independent subscriptions, one active controller.
//
// At the merged staging SHA this Case proves, against one exact checkout:
//   1. two same-origin tabs (one browser client id, two subscription ids) are
//      separate subscriptions: both receive the session's output, the second
//      is an observer, and an explicit takeover moves the generation;
//   2. the replaced tab's in-flight input is refused by name, and its passive
//      reconnect does not take the lease; A -> B -> A fences B's frame;
//   3. the lease identity rule is the subscription, not the shared browser id.
const {
  run, targetSha, cargoTests, assertRan, tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();

  const identity = cargoTests(
    ['--lib', 'session::terminal::state::tests::same_browser_tabs_are_separate_lease_identities'],
    300000,
  );
  assertRan(identity, [
    'session::terminal::state::tests::same_browser_tabs_are_separate_lease_identities',
  ]);

  const tabs = cargoTests(
    ['--test', 'integration', 'server::integration_two_tabs_of_one_browser_broadcast_and_take_over'],
    300000,
  );
  assertRan(tabs, [
    'server::integration_two_tabs_of_one_browser_broadcast_and_take_over',
  ]);

  const fence = cargoTests(
    ['--test', 'integration', 'server::integration_input_from_a_stale_lease_is_refused_without_writing'],
    300000,
  );
  assertRan(fence, [
    'server::integration_input_from_a_stale_lease_is_refused_without_writing',
  ]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + version +
        ': two subscriptions sharing one browser client id both received output; the second was an observer until it explicitly acquired, and the replaced controller\'s frame was refused as not_controller',
    },
    {
      type: 'runtime',
      value:
        'a passive reconnect kept the observer role; A -> B -> A advanced the generation and fenced B\'s stale input',
    },
  );
  return 'Same-origin tabs subscribe and receive broadcast independently, and only the most recently active subscription controls input/resize';
});
