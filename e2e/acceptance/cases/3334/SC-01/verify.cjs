'use strict';
// #3334 SC-01: an authenticated submission returns a stable build_id without
// waiting for Git/mkfs; get/list read the durable directory snapshot; the
// legacy synchronous unit and invalid inputs are explicitly versioned.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { runCargoTests } = require('../../../shared/erofs-cases.cjs');
const { assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const protocol = runCargoTests('nession-protocol', 'contracts::image::tests');
  assertRan(protocol, [
    'contracts::image::tests::build_ids_and_client_request_ids_have_one_bounded_shape',
    'contracts::image::tests::build_statuses_and_stages_round_trip_their_wire_names',
    'contracts::image::tests::a_build_descriptor_never_serializes_an_unmeasured_progress_fraction',
  ]);
  const handlers = runCargoTests(
    'nession-server',
    'server::handler::tests::server_image_build_lifecycle_v1',
  );
  assertRan(handlers, [
    'server::handler::tests::server_image_build_lifecycle_v1::every_build_unit_refuses_an_unauthenticated_caller',
    'server::handler::tests::server_image_build_lifecycle_v1::malformed_build_payloads_are_refused_with_the_shared_shape',
    'server::handler::tests::server_image_build_lifecycle_v1::submit_returns_a_build_record_and_get_list_read_it_back',
  ]);
  const lifecycle = runCargoTests('nession-server', 'image::async_build_tests');
  assertRan(lifecycle, [
    'image::async_build_tests::submission_returns_a_durable_record_before_the_build_finishes',
    'image::async_build_tests::duplicate_submission_is_idempotent_and_legacy_build_returns_a_ready_image',
    'image::async_build_tests::corrupted_durable_state_is_rejected_not_resumed',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': build submit returned a stable build id before the worker finished; ' +
      'get/list read the same durable state; duplicate client_request_id was idempotent and a ' +
      'conflicting reuse was refused; the legacy server.image.build still returned a ready Image ' +
      'descriptor; unauthenticated/malformed/invalid/unknown inputs produced their declared refusals',
  });
  return 'Asynchronous submission, durable observation, legacy compatibility and input refusals are versioned and proven';
});
