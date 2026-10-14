#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Reporter = require('./issue-e2e-assertion-reporter.cjs');

assert.equal(Reporter.countExpectSteps([{category:'fixture'},{
  category:'test.step',steps:[{category:'expect'},{category:'expect'}]
}]),2);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nession-e2e-assertions-'));
const old=process.env.NESSION_E2E_ASSERTIONS_OUTPUT_FILE;
try{
  const output=path.join(temp,'assertions.json');
  process.env.NESSION_E2E_ASSERTIONS_OUTPUT_FILE=output;
  const reporter=new Reporter();
  reporter.onTestEnd({
    title:'create session',
    location:{file:'/tmp/e2e/tests/browser/session-lifecycle.spec.ts',line:46}
  },{
    retry:0,status:'passed',
    steps:[{category:'fixture'},{category:'expect',title:'toBeVisible'},
      {category:'test.step',steps:[{category:'expect',title:'toHaveText'}]}]
  });
  reporter.onEnd();
  const receipt=JSON.parse(fs.readFileSync(output,'utf8'));
  assert.deepEqual(receipt,{
    schema_version:1,kind:'playwright_assertion_steps',
    tests:[{id:'session-lifecycle',title:'create session',line:46,retry:0,status:'passed',assertions:2}]
  });
  assert.throws(()=>reporter.onEnd(),/EEXIST/);
  process.env.NESSION_E2E_ASSERTIONS_OUTPUT_FILE='relative-file';
  assert.throws(()=>new Reporter().onEnd(),/absolute|path is required/);
  console.log('Trusted Playwright assertion reporter: nested expect counting, provenance and output negatives passed');
} finally {
  if(old===undefined)delete process.env.NESSION_E2E_ASSERTIONS_OUTPUT_FILE;
  else process.env.NESSION_E2E_ASSERTIONS_OUTPUT_FILE=old;
  fs.rmSync(temp,{force:true,recursive:true});
}
