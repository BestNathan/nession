'use strict';
// #3498 SC-04: the external OCI Distribution client keeps upstream registry
// credentials behind a Server-owned provider, gates every import through a
// Server-owned authorizer before I/O, and projects only local digest grants.
// The Agent's declared nession-erofs dependency does not enable the registry
// feature at all. These are exact-SHA executable tests and cargo metadata
// facts, not source inspection.
const { run, targetSha, assertRan, crateTests, checked } = require('../../../shared/control-mode-cases.cjs');

function cargoMetadata() {
  const raw = checked('cargo', ['metadata', '--no-deps', '--format-version', '1'], 120_000);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('cargo metadata returned no JSON package graph');
  return JSON.parse(raw.slice(start, end + 1));
}

run(({ evidence }) => {
  const sha = targetSha();
  const boundary = crateTests(
    'nession-erofs',
    ['registry::pull::tests::denied_import_never_reaches_the_registry_or_credentials'],
    600_000,
  );
  assertRan(boundary, [
    'registry::pull::tests::denied_import_never_reaches_the_registry_or_credentials',
  ]);
  const grants = crateTests(
    'nession-erofs',
    ['registry::pull::tests::agent_grant_projects_only_local_digests_and_no_credentials'],
    600_000,
  );
  assertRan(grants, [
    'registry::pull::tests::agent_grant_projects_only_local_digests_and_no_credentials',
  ]);
  const auth = crateTests(
    'nession-erofs',
    ['registry::auth::tests::credentials_are_redacted_and_basic_encoding_is_private'],
    600_000,
  );
  assertRan(auth, [
    'registry::auth::tests::credentials_are_redacted_and_basic_encoding_is_private',
  ]);
  const bearer = crateTests(
    'nession-erofs',
    ['registry::pull::tests::private_registry_bearer_challenge_succeeds_without_leaking_credentials'],
    600_000,
  );
  assertRan(bearer, [
    'registry::pull::tests::private_registry_bearer_challenge_succeeds_without_leaking_credentials',
  ]);
  const scope = crateTests(
    'nession-erofs',
    ['registry::pull::tests::a_challenge_scope_cannot_name_another_repository'],
    600_000,
  );
  assertRan(scope, [
    'registry::pull::tests::a_challenge_scope_cannot_name_another_repository',
  ]);
  const server = crateTests('nession-server', ['registry_boundary'], 600_000);
  assertRan(server, [
    'registry_boundary::server_owned_registry_boundary_denies_cross_tenant_import_before_io',
  ]);

  const metadata = cargoMetadata();
  const erofs = metadata.packages.find((pkg) => pkg.name === 'nession-erofs');
  const agent = metadata.packages.find((pkg) => pkg.name === 'nession-agent');
  if (!erofs || !agent) throw new Error('cargo metadata is missing nession-erofs or nession-agent');
  const defaults = (erofs.features && erofs.features.default) || [];
  if (!defaults.includes('registry')) {
    throw new Error('nession-erofs default features do not include registry');
  }
  const agentDependency = agent.dependencies.find((dep) => dep.name === 'nession-erofs');
  if (!agentDependency) throw new Error('nession-agent does not declare nession-erofs');
  if (agentDependency.uses_default_features) {
    throw new Error('nession-agent enables nession-erofs default features');
  }
  const agentFeatures = [...agentDependency.features].sort();
  if (agentFeatures.join(',') !== 'cache,mount') {
    throw new Error('nession-agent nession-erofs features are ' + agentFeatures.join(','));
  }
  if (agentFeatures.includes('registry') || agentFeatures.includes('default')) {
    throw new Error('nession-agent dependency enables the registry credential surface');
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a Server-owned authorizer denial and a cross-tenant ' +
      'tenant-a/tenant-b denial both failed before any registry HTTP request or ' +
      'credential-provider call, and before any catalog/tag write; the imported ' +
      'Agent-facing grant contained only local Manifest/Config/EROFS digests with ' +
      'no provider secret, username, bearer token or registry URL; the private ' +
      'registry Bearer challenge downloaded with only repository:team/private:pull, ' +
      'refused a challenge scope naming another repository, and redacted credential ' +
      'Debug output; the Server integration test supplied a Server-owned secret ' +
      'provider and tenant policy, denied a tenant-b import before any HTTP request ' +
      'or provider call, and left no local tag/blob; cargo metadata shows ' +
      'nession-erofs default features include registry while nession-agent declares ' +
      'default-features=false with only cache,mount',
  });
  return 'Server-owned import authorization gates pull before I/O and credentials, Agent-facing grants carry only local digests, and the Agent dependency graph excludes the registry feature';
});
