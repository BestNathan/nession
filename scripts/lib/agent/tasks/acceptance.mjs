import { renderAgentPrompt } from '../prompt/index.mjs';

export function renderAcceptancePrompt(context) {
  return renderAgentPrompt({
    id: 'acceptance',
    version: 'v1',
    context: { contextJson: JSON.stringify({
      issue: context.issue, stage: context.stage, target_ref: context.target_ref,
      deployment: context.deployment, ci_evidence: context.ci_evidence ?? null,
      criteria: context.criteria, requirement_body: context.requirement_body,
    }, null, 2) },
  });
}
