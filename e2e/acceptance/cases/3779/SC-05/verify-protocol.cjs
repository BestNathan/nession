'use strict';
// #3779 SC-05 (4/4): the reused conversation/transcript Protocol contracts
// (identity, no transcript path, canonical pagination, large-record
// placeholders, unknown/unreadable states) and the SessionStart/SessionEnd
// Hook binding fallback the new Tools must not replace by guesswork.
const {
  run, targetSha, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-3779-sc05-protocol');
  const protocol = crateTests(
    'nession-claude-code',
    ['--lib', 'protocol::'],
    600000,
    env,
  );
  assertRan(protocol, [
    'protocol::conversations::v1::tests::the_descriptor_names_this_unit_its_owner_and_its_wire',
    'protocol::conversations::v1::tests::an_item_never_serializes_a_filesystem_path',
    'protocol::messages::v1::tests::a_not_found_response_names_no_other_conversation',
    'protocol::messages::v1::tests::a_response_never_serializes_a_filesystem_path',
    'protocol::transcripts::v1::tests::the_descriptor_names_this_unit_its_owner_and_its_wire',
    'protocol::transcript_records::v1::tests::a_record_without_inline_raw_says_so_by_absence_not_truncation',
    'protocol::transcript_record::v1::tests::the_descriptor_names_this_unit_its_owner_and_its_wire',
  ]);
  const fallback = crateTests(
    'nession-claude-code',
    ['--lib', 'binding::'],
    600000,
    env,
  );
  assertRan(fallback, [
    'binding::tests::a_session_start_payload_binds_the_conversation',
    'binding::tests::a_session_end_binding_is_kept_and_marked_finished',
  ]);
  const hook = crateTests(
    'nession-claude-code',
    ['--lib', 'plugin::tests::the_hook_writes_for_new_and_surviving_legacy_sessions'],
    600000,
    env,
  );
  assertRan(hook, [
    'plugin::tests::the_hook_writes_for_new_and_surviving_legacy_sessions',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': existing conversation/transcript Protocol contracts (identity, pagination, unknown-record placeholders, no path) and the SessionStart/SessionEnd Hook binding fallback remained green',
  });
  return 'the reused Protocol contracts and the Hook binding fallback show no regression';
});
