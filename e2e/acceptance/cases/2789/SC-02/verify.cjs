'use strict';
// #2789 SC-02: the versioned metadata read/update round-trips; invalid values,
// unauthorized targets and stale revisions fail explicitly and leave prior
// metadata intact; old/legacy shapes stay readable.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, targetSha, cargoTests, assertRan, checked,
} = require('../../../shared/control-mode-cases.cjs');

const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2789-sc02-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

run(({ evidence }) => {
  const sha = targetSha();

  const protocol = checked(
    'cargo',
    ['test', '-p', 'nession-protocol', 'contracts::session::tests::', '--', '--nocapture'],
    300_000,
  );
  assertRan(protocol, [
    'contracts::session::tests::absent_metadata_is_revision_zero_and_old_payloads_stay_readable',
    'contracts::session::tests::metadata_round_trips_and_display_title_prefers_a_nonempty_title',
    'contracts::session::tests::metadata_validation_trims_and_counts_unicode_codepoints',
    'contracts::session::tests::metadata_validation_rejects_invalid_tags',
  ]);

  const server = checked(
    'cargo',
    ['test', '-p', 'nession-server', '--lib', 'server_session_metadata_v1', '--', '--nocapture'],
    300_000,
  );
  assertRan(server, [
    'metadata_get_requires_an_authenticated_client',
    'a_malformed_session_id_is_refused_before_any_agent_is_asked',
    'an_agents_conflict_keeps_its_kind_and_detail',
    'a_success_without_metadata_is_a_refusal_not_a_second_hand_success',
  ]);

  const routed = cargoTests(
    ['--test', 'integration', 'integration_session_metadata_round_trips_through_the_routed_socket'],
    300_000,
    tmuxEnv,
  );
  assertRan(routed, [
    'server::integration_session_metadata_round_trips_through_the_routed_socket',
  ]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': Session metadata round-trips through the routed Agent socket — ' +
        'legacy revision 0, a revision-guarded first save at revision 1, a stale revision refused ' +
        'as conflict with the stored title intact, and duplicate tags refused as invalid',
    },
    {
      type: 'runtime',
      value:
        'the Server refused unauthenticated, malformed and unknown targets before asking any ' +
        'Agent; a success without metadata became `unavailable`, and an Agent conflict kept its ' +
        'kind and detail. Protocol tests cover legacy payload readability, codepoint bounds and ' +
        'invalid-tag rejection',
    },
  );
  return 'Authorized reads/writes round-trip and every invalid, unauthorized or stale case fails explicitly';
});
