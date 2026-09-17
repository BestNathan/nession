import { AgentsPlugin } from './AgentsPlugin';
export { AgentsPlugin } from './AgentsPlugin';
export type { AgentDeleteResponse, AgentRenameResponse, AgentsListResponse } from './types';

/** App-level singleton — one agents binding per WebSocketService lifetime. */
export const agentsApi = new AgentsPlugin();
