'use strict';
// #3018 SC-01: the Agent command sanitizer fails closed in the value position
// after a recognized sensitive flag, including leading-hyphen values. The
// ordinary flags, a missing value and the `--` terminator keep their readable
// behavior. These are the canonical source tests at the exact target SHA.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const {
  runProcessDiscoveryTests,
} = require('../../../shared/process-discovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const names = [
    'a_secret_flag_takes_the_next_argument_as_its_value',
    'a_secret_flag_redacts_a_leading_hyphen_value',
    'a_secret_flag_redacts_a_consecutive_flag_value',
    'a_sensitive_flag_without_a_value_is_unchanged',
    'the_double_dash_terminator_is_not_a_secret_value',
    'ordinary_flags_outside_the_value_position_stay_readable',
    'an_ordinary_flag_that_merely_starts_with_auth_is_not_redacted',
  ];
  runProcessDiscoveryTests(names);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': ' + names.join('; ') +
      ' each Passed — leading-hyphen, consecutive-flag and absent-value positions are sanitized, while ordinary flags and the -- terminator stay readable',
  });
  return 'The value after a sensitive flag is redacted even when it begins with a hyphen; ordinary flags, missing values and the -- terminator remain readable';
});
