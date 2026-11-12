'use strict';
const { run, githubTests, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  githubTests('runtime::remote::tests', [
    'runtime::remote::tests::parses_https_ssh_scp_and_strips_credentials',
    'runtime::remote::tests::rejects_unknown_schemes_aliases_and_non_repo_paths',
  ]);
  ev.push(evidence('runtime', 'HTTPS, scp-style SSH and ssh:// normalize to host/owner/repo; embedded credentials are stripped; aliases, unknown schemes and non-repo paths are rejected'));
  return 'Supported remotes normalize safely without leaking credentials or accepting aliases';
});
