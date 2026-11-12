'use strict';
// #2681 SC-01: the versioned policy accepts only known keys, validates native
// value formats, and refuses an unsupported capability combination. The
// executable proof is the exact-SHA contract/validation suites: unknown keys,
// unknown versions, unknown enum values, native cgroup formats, egress
// precedence and private-address refusal, and fail-closed capability checks.
const { run, targetSha, checked, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const contract = checked(
    'cargo',
    ['test', '-p', 'nession-protocol', '--lib', 'contracts::sandbox', '--', '--nocapture'],
    300000,
  );
  assertRan(contract, [
    'contracts::sandbox::v1::tests::the_illustrative_policy_round_trips_with_native_cgroup_keys',
    'contracts::sandbox::v1::tests::unknown_fields_are_refused_at_the_schema_boundary',
    'contracts::sandbox::v1::tests::unknown_cgroup_keys_are_refused_rather_than_written',
    'contracts::sandbox::v1::tests::unknown_enum_values_are_refused',
  ]);

  const policy = checked(
    'cargo',
    ['test', '-p', 'nession-sandbox', '--lib', '--', '--nocapture'],
    600000,
  );
  assertRan(policy, [
    'policy::tests::unknown_versions_are_unsupported_not_interpreted',
    'policy::tests::native_cgroup_values_are_validated_in_their_own_units',
    'policy::tests::cgroup_namespace_requires_a_user_namespace_request',
    'policy::tests::a_disabled_policy_may_not_carry_constraints',
    'policy::tests::unknown_seccomp_profiles_are_unsupported',
    'policy::tests::relative_or_unnormalized_paths_are_rejected',
    'network::tests::deny_precedes_allow',
    'network::tests::wildcards_match_subdomains_never_the_base',
    'network::tests::host_local_and_metadata_addresses_are_always_refused',
    'network::tests::malformed_rules_fail_closed',
    'capabilities::tests::a_missing_backend_is_refused_with_its_measured_reason',
    'capabilities::tests::linux_native_keys_are_refused_on_macos',
    'capabilities::tests::undelegated_cgroup_controllers_are_refused',
    'capabilities::tests::restricted_network_requires_the_bridge',
  ]);

  evidence.push(
    { type: 'runtime', value: 'exact SHA ' + sha + ': 4 contract negative cases ran at the schema boundary' },
    { type: 'runtime', value: 'unknown schema versions, enum values and cgroup keys were refused, not interpreted or written' },
    { type: 'runtime', value: 'native cgroup formats were parsed and invalid quota/period/max values failed closed' },
    { type: 'runtime', value: 'egress deny precedence, wildcard base exclusion and private/metadata refusal ran' },
    { type: 'runtime', value: 'a missing backend, undelegated controllers, the absent bridge and Linux-native keys on macOS were refused with UnsupportedPolicy/BackendUnavailable' },
  );
  return 'The versioned policy validates only supported known keys and native formats, and an unavailable guarantee fails closed on both platforms';
});
