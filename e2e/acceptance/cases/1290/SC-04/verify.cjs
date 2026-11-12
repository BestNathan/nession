'use strict';
const { run, githubTests, requires, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  githubTests('agent::tests::a_client_supplied_repository_is_ignored', ['agent::tests::a_client_supplied_repository_is_ignored_and_never_reaches_the_request']);
  githubTests('agent::tests::repository_resolves', ['agent::tests::repository_resolves_from_the_session_live_git_remotes']);
  requires('crates/nession-github/src/protocol/mod.rs', ['pub session: String', 'pub remote_name: Option<String>']);
  requires('web/src/capabilities/git/GithubPlugin.ts', ['addressedPayload', 'CONSUMER_REQUIREMENTS']);
  ev.push(evidence('runtime', 'the request carries only the Session and an Agent-discovered remote name; owner/repo/host/path fields supplied by a client are ignored and cannot select a repository'));
  return 'Every GitHub target resolves from the authorized Agent Session and its live repository';
});
