'use strict';
const { run, githubTests, requires, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  githubTests('runtime::client::tests::status_errors', ['runtime::client::tests::status_errors_are_typed_and_a_redirect_is_never_followed']);
  githubTests('runtime::remote::tests', [
    'runtime::remote::tests::parses_https_ssh_scp_and_strips_credentials',
    'runtime::remote::tests::rejects_unknown_schemes_aliases_and_non_repo_paths',
  ]);
  requires('crates/nession-github/src/runtime/client.rs', ['self.api_base.as_ref().and_then(Url::host_str) != url.host_str()', 'Policy::none()', 'HostNotAllowed']);
  ev.push(evidence('runtime', 'credential-bearing/custom URLs cannot widen the API origin; a 3xx is refused and host checks run before an authenticated request'));
  return 'Untrusted URLs, hosts and redirects cannot cause credential-bearing requests to an unapproved endpoint';
});
