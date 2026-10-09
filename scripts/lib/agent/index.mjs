// Canonical AI Agent library. Deep-import tools explicitly by integration/task;
 // importing this entrypoint never enables capabilities or performs provider setup.
export { renderAgentPrompt } from './prompt/index.mjs';
export { renderIssueAuditPrompt, applyIssueAuditProposal } from './tasks/issue-audit.mjs';
export { renderAcceptancePrompt } from './tasks/acceptance.mjs';
export { promptTelemetry } from './telemetry/prompt.mjs';
