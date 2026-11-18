'use strict';
// #3779 SC-05: the six Claude Tools enforce explicit Agent/Session targets and
// typed input/output schemas, and the contributed-Tool routing contract they
// ride is proven on the Agent's own catalog and on Server-embedded and
// Standalone hosts. The existing conversation/transcript Protocol contracts and
// the SessionStart/SessionEnd Hook binding fallback must remain green.
const {
  run, targetSha, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-3779-sc05');

  // Every Tool owns one target-validation rule and one closed typed contract.
  // The filter names each Tool's own refusal and schema test, so a Tool that
  // loses its guard or its typed output cannot be hidden by the others.
  const tools = crateTests(
    'nession-claude-code',
    ['--lib', 'tools::nession_claude_'],
    600000,
    env,
  );
  assertRan(tools, [
    'tools::nession_claude_status::tests::a_foreign_agent_is_refused_not_observed_locally',
    'tools::nession_claude_status::tests::both_identity_fields_are_required_and_unexpected_keys_are_refused',
    'tools::nession_claude_enter::tests::a_foreign_target_is_refused',
    'tools::nession_claude_enter::tests::the_contract_requires_the_target_and_mode',
    'tools::nession_claude_submit::tests::a_foreign_target_is_refused_before_any_input',
    'tools::nession_claude_submit::tests::the_contract_requires_every_routing_and_content_field',
    'tools::nession_claude_list_conversations::tests::foreign_and_malformed_targets_are_refused_before_any_read',
    'tools::nession_claude_list_conversations::tests::the_contract_requires_the_target_and_advertises_the_unit_output',
    'tools::nession_claude_get_conversation::tests::a_missing_foreign_or_blank_identity_is_refused_before_any_read',
    'tools::nession_claude_get_conversation::tests::the_contract_requires_the_conversation_and_advertises_the_unit_output',
    'tools::nession_claude_get_transcript::tests::the_two_modes_cannot_be_mixed_or_defaulted',
    'tools::nession_claude_get_transcript::tests::the_contract_advertises_both_modes_without_exposing_a_path',
  ]);

  // The Agent's own shared catalog advertises all six Tools with their typed
  // schemas, and the three read Tools execute the existing Units against the
  // same real Session truth the endpoint serves.
  const agent = crateTests(
    'nession-agent',
    ['--test', 'integration',
      'mcp::agent_mcp_exposes_the_claude_conversation_and_transcript_readers'],
    900000,
    env,
  );
  assertRan(agent, [
    'mcp::agent_mcp_exposes_the_claude_conversation_and_transcript_readers',
  ]);

  // The general contribution contract these Tools ride: Server-embedded and
  // Standalone hosts route a contributed Tool to the explicitly named owner,
  // and wrong Agent, offline owner, unknown owner-specific Session and
  // incompatible/stale manifest fail closed with no cross-Agent fallback. The
  // Agent's direct P2P surface executes its own contribution and refuses a
  // foreign agent_id and an unadvertised Tool.
  const routing = crateTests(
    'nession-mcp',
    ['--test', 'integration',
      'standalone::extension_tool_routes_to_the_named_agent_across_hosts'],
    900000,
    env,
  );
  assertRan(routing, [
    'standalone::extension_tool_routes_to_the_named_agent_across_hosts',
  ]);
  const p2p = crateTests(
    'nession-agent',
    ['--test', 'integration',
      'mcp::agent_p2p_mcp_tool_call_executes_its_own_contribution'],
    900000,
    env,
  );
  assertRan(p2p, [
    'mcp::agent_p2p_mcp_tool_call_executes_its_own_contribution',
  ]);

  // The reused Protocol contracts (identity, no transcript path, canonical
  // pagination, large-record placeholders, unknown/unreadable states) and the
  // Hook binding fallback the new Tools must not replace by guesswork.
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
    value: 'exact SHA ' + sha + ': each of the six Claude Tools refused a foreign Agent/Session target and advertised a closed typed input contract with its Unit-owned output schema',
  });
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the Agent catalog advertised all six Tools and the three read Tools executed the existing conversation/transcript Units against a real Session (empty ready list, exact-id not_found, no substituted conversation, no transcript path)',
  });
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the contributed-Tool routing contract carried the Tools to the named owner on Server-embedded and Standalone hosts, wrong Agent/offline owner/unknown owner-specific Session failed closed with no fallback, and the direct P2P surface refused a foreign Agent and an unadvertised Tool',
  });
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': existing conversation/transcript Protocol contracts (identity, pagination, unknown-record placeholders, no path) and the SessionStart/SessionEnd Hook binding fallback remained green',
  });

  return 'The six Claude Tools enforce explicit targets and typed schemas; their contributed-Tool routing is proven across Agent, Server and Standalone hosts; the reused conversation/transcript contracts and Hook binding fallback show no regression.';
});
