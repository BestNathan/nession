'use strict';
const { run, rustTests, webTests, requires, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  rustTests('nession-agent', ['--lib', 'runtime::tests::the_runtime_composes_the_agent_providers'],
    ['runtime::tests::the_runtime_composes_the_agent_providers']);
  webTests('unit', 'src/capabilities/git/__tests__/unit/GithubPlugin.test.ts', 'exposes the "github"', 1);
  requires('crates/nession-agent/src/runtime.rs', ['GithubAgentExtension', 'GitAgentExtension', 'Arc::new(GithubClient::from_env())']);
  requires('web/src/capabilities/git/contribution.tsx', ['GIT_ID', 'gitView']);
  ev.push(evidence('runtime', 'one Git capability composes nession-git and nession-github under the same Agent; the Web registers git/github as transport providers, not a second Product Capability'));
  return 'One Git capability exposes the local repository and GitHub hosting context';
});
