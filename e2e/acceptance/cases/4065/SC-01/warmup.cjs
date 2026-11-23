'use strict';
// #4065 SC-01 warmup (verifier 1 of 3): compile the nession-server integration
// test binary once, without running any test. The driver SIGKILLs every verifier
// process at 120s; the cold Cargo compile of this binary (~60s) plus a ~45-50s
// watchdog test would otherwise overflow the first proof verifier's budget
// (run 45164349512: half-open.cjs ETIMEDOUT at 110s). Compiling here lets the two
// proof verifiers run warm (~48s / ~54s) with full headroom, reusing this Cargo
// target cache (#3735 pattern). This verifier proves no criterion itself; the
// half-open and idle-survival verifiers carry the exact SC-01 assertions.
const {run,targetSha,checked}=require('../../../shared/control-mode-cases.cjs');
run(({evidence})=>{
  const sha=targetSha();
  checked('cargo',['test','-p','nession-server','--test','integration','--no-run'],110_000);
  evidence.push({type:'runtime',value:sha+': compiled the nession-server integration test binary (cargo test --no-run) so the half-open and idle-survival proof verifiers execute warm within the per-verifier 120s cap'});
  return 'Integration test binary compiled for the SC-01 proof verifiers';
});
