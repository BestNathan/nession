'use strict';
// Exact-SHA source-aligned Case for #2459 SC-02.
//
// Two witnesses, both run against the target checkout:
//
// 1. The deterministic control-wire interleaving. A peer's newer
//    `%layout-change` arrives while this client's `refresh-client` reply is
//    still pending; the older completion must not overwrite it, and the
//    reassertion must issue `resize-window` instead of being suppressed by
//    `window_is_at`.
// 2. Isolated real tmux. Two control clients share one window; the authorized
//    client's later resize moves the real window the peer is looking at, and
//    the peer receives the authoritative size. The integration tests skip on
//    macOS, so the real-tmux witness executes on the Ubuntu Case runner.
const {
  run, targetSha, cargoTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const race =
    'tmux::control::tests::a_peer_resize_during_the_refresh_reply_is_not_overwritten_by_the_older_completion';
  assertRan(cargoTests(['--lib', race], 180000), [race]);

  for (const name of [
    'control_mode::two_clients_share_one_window',
    'control_mode::a_peer_driven_resize_reaches_the_other_client',
  ]) {
    assertRan(cargoTests(['--test', 'integration', name], 300000), [name]);
  }

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha +
        ': a peer report during a pending refresh reply survives the older completion, and the next same-size request emits resize-window',
    },
    {
      type: 'runtime',
      value:
        'isolated real tmux: two control clients share one window; the authorized resize moves it after the peer move and the peer receives the authoritative size',
    },
  );
  return 'After a peer moves the shared window, the authorized client reasserts its size without suppression, the older completion never overwrites the newer tmux report, and real tmux converges without an unrelated detach';
});
