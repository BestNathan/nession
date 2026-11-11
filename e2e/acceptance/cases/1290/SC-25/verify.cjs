'use strict';
const { run, githubTests, requires, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  githubTests('agent::tests::an_api_read_without_a_credential', ['agent::tests::an_api_read_without_a_credential_is_not_authenticated_and_makes_no_request']);
  requires('crates/nession-github/Cargo.toml', ['reqwest']);
  requires('crates/nession-github/src/runtime/client.rs', ['GITHUB_TOKEN', 'GH_TOKEN', 'not_authenticated']);
  const docker = require('../../../shared/github-context-cases.cjs').source('Dockerfile.agent');
  if (docker.includes('gh ')) throw new Error('the Agent image is expected to use the typed HTTP client, not gh');
  ev.push(evidence('runtime', 'the supported Agent runtime constructs the typed client from its own token env; without a token it answers not_authenticated instead of failing startup or depending on CI-host gh'));
  return 'Supported Agent runtimes expose the packaged client/auth or an honest unavailable state';
});
