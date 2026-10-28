'use strict';
// #2557 SC-04: reuse the same executable terminal-sizing boundary proven
// by #2487 SC-08. Keeping one verifier owner prevents the 96-column
// release default from getting a weaker, divergent copy of the test.
require('../../2487/SC-08/verify.cjs');
