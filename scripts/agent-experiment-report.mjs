#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generatePinnedReport,renderExperimentMarkdown} from './lib/agent/telemetry/experiment-report.mjs';

const argv=process.argv.slice(2);
async function main(){
  if(argv[0]==='self-test'){
    await import('./lib/agent/telemetry/experiment-report-selftest.mjs');
    return;
  }
  if(argv[0]!=='generate'||argv.length!==6){
    throw new Error('usage: generate METRICS_CHECKOUT METRICS_SHA TRUSTED_ISSUE_EVIDENCE_JSON EVIDENCE_SHA256 OUTPUT_DIR');
  }
  const [,root,metricsSha,evidenceFile,evidenceSha,output]=argv;
  const {report,manifest}=generatePinnedReport(root,metricsSha,evidenceFile,evidenceSha);
  const directory=path.resolve(output);
  if(fs.existsSync(directory)&&fs.readdirSync(directory).length){
    throw new Error('output directory must be empty (immutable report)');
  }
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  fs.writeFileSync(path.join(directory,'lineage.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  fs.writeFileSync(path.join(directory,'report.md'),renderExperimentMarkdown(report),{flag:'wx'});
  console.log('Agent experiment report generated from pinned read-only sources.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
