'use strict';
const { main } = require('../../../shared/knowledge-ledger-acceptance.js');
main('negative').then((r) => process.stdout.write(JSON.stringify(r) + '\n')).catch((e) => {
 const m = e instanceof Error ? e.stack || e.message : String(e); process.stderr.write(m + '\n');
 process.stdout.write(JSON.stringify({status:'fail',summary:m,evidence:[{type:'knowledge-ledger',value:'Acceptance verifier failed'}]})+'\n'); process.exitCode=1;
});
