'use strict';
const { run, githubTests, webTests, requires, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  githubTests('runtime::cache::tests', [
    'runtime::cache::tests::caches_a_value_and_refresh_bypasses_it',
    'runtime::cache::tests::concurrent_callers_share_one_fetch',
  ]);
  webTests('integration', 'src/capabilities/git/hooks/__tests__/integration/useGithubRequest.test.tsx', 'drops a response from the previous Session', 1);
  requires('crates/nession-github/src/agent.rs', ['target.session', 'remote.remote_name', 'identity.source_url', 'auth_fingerprint', 'branch.unwrap_or']);
  ev.push(evidence('runtime', 'the short-lived cache is keyed by Session, remote/repository, branch, auth fingerprint and operation; concurrent callers dedup; refresh bypasses it; identity changes cannot reuse or publish old data'));
  return 'Cache/dedup are auth- and identity-scoped and invalidate correctly';
});
