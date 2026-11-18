'use strict';
// #3910 SC-02: Project-context create validates the Project and its declared
// Existing Location, inherits Project ENV defaults or takes an explicit
// replacement, delegates to the canonical Server create, and reports only a
// confirmed persisted project_id. Invalid input and ambiguous/partial binding
// outcomes are never unqualified successful Project creates.
const {
  run, targetSha, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-3910-sc02');

  const unit = crateTests(
    'nession-mcp',
    ['--lib', 'tools::nession_server_project_session_create::tests::'],
    600_000,
    env,
  );
  assertRan(unit, [
    'existing_target_inherits_project_defaults_by_default',
    'replace_uses_the_explicit_env_selection',
    'replace_accepts_an_explicit_empty_selection',
    'replace_without_an_explicit_selection_is_refused',
    'inherit_with_an_explicit_selection_is_refused',
    'managed_target_reuses_the_canonical_managed_contract',
    'an_unconfirmed_project_association_is_not_reported_as_success',
    'an_ambiguous_create_requires_readback_before_retry',
    'a_malformed_project_identity_never_reaches_the_backend',
  ]);

  const runtime = crateTests(
    'nession-mcp',
    [
      '--test',
      'integration',
      'standalone::project_context_sessions_use_server_association_and_real_agent_runtime',
    ],
    900_000,
    env,
  );
  assertRan(runtime, [
    'standalone::project_context_sessions_use_server_association_and_real_agent_runtime',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': an isolated real Server + registered real tmux Agent created a Session through a declared Existing Location; the reply carried the confirmed persisted project_id; absent environment inherited the Project ENV profile and replace used the explicit list; an undeclared directory, unknown Project and Managed target without a Project image were refusals',
  });
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the Tool unit contract requires a confirmed project_id for success and reports a created-but-unassociated Session as a readback-before-retry error, not as a successful Project create',
  });
  return 'Project-context create validates through the Server, inherits or explicitly replaces Project ENV, and reports only a confirmed association';
});
