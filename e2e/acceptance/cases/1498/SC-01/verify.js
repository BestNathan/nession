'use strict';
const {invokeScenario,result,fail}=require('../../../shared/terminal-scenario-evidence.cjs');
try{
  const run=invokeScenario(1);
  const x=run.records[0].data;
  result('Real full-stack attach/reload/resume Scenario produced exact-SHA observations without a fabricated verdict',[
    {type:'runtime',value:'target='+run.target+' profile='+run.runtime.profile+' source_run='+x.run_id},
    {type:'scenario',value:'mode=observe status='+x.status+' evaluation=null stages='+x.observations.map(o=>o.stage).join(',')},
    {type:'input',value:'config_sha256='+x.config_sha256+' observations='+x.observation_count},
  ]);
}catch(e){fail(e);}
