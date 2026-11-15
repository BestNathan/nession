'use strict';
// #3581 SC-03: an actual affected PR/run attempt must show the canonical
// deterministic updater completing (or reporting a precise bounded provenance
// denial) with the original Run/Job/Step and Issue projection linked. The fix
// only takes effect from trusted main, and no authenticated post-fix runtime
// receipt exists yet, so this criterion stays Pending rather than inferring a
// Pass from the deterministic fixtures.
process.stdout.write(JSON.stringify({
  status: 'pending',
  summary: 'Awaiting an authenticated post-fix affected-PR Acceptance updater receipt at the exact merged main SHA',
  evidence: [],
}) + '\n');
