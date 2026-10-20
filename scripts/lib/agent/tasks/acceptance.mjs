import { renderAgentPrompt } from '../prompt/index.mjs';
import { extractSection } from '../../../requirement-acceptance.mjs';

// Historical results remain in the immutable executor context for authenticated
// reuse and normalization. They are NOT fresh evidence for a new model verdict.
export function acceptanceModelView(context) {
  let body=String(context.requirement_body??'');
  const projected=extractSection(body,'Acceptance Report');
  if(projected)body=body.replace(projected,
    '[Prior result projection omitted from fresh evaluation; use independently collected evidence.]');
  body=body.replace(/^(\s*-\s+)\[[ xX]\](\s+SC-\d+\b)/gm,'$1[ ]$2');
  return {
    issue:context.issue,stage:context.stage,target_ref:context.target_ref,
    deployment:context.deployment,ci_evidence:context.ci_evidence??null,
    criteria:(context.criteria??[]).map(c=>({criterion:c.criterion,text:c.text,stage:c.stage,
      proof_method:'agent'})),
    contract_sha256:context.contract_sha256??null,
    evaluation_run_id:context.run_id??null,
    prior_projection_is_not_new_evidence:true,
    requirement_body:body,
  };
}
export function renderAcceptancePrompt(context) {
  return renderAgentPrompt({
    id:'acceptance',version:'v2',
    context:{contextJson:JSON.stringify(acceptanceModelView(context),null,2)},
  });
}
