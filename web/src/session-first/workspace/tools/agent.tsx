import { UserRound } from 'lucide-react';
import type { WorkspaceTool } from '../toolTypes';
import { AppToolScroll } from '../AppToolScroll';
import { AgentDetail } from '@/session-first/patterns/AgentDetail';

export const agentTool: WorkspaceTool = {
  id: 'agent',
  label: 'Agent',
  icon: UserRound,
  order: 30,
  availability: () => true,
  layout: {
    web: ({ ctx }) => (ctx.agent && ctx.domain ? <AgentDetail agent={ctx.agent} state={ctx.domain} /> : null),
    app: ({ ctx }) =>
      ctx.agent && ctx.domain ? (
        <AppToolScroll data-testid="agent-detail-app">
          <AgentDetail agent={ctx.agent} state={ctx.domain} />
        </AppToolScroll>
      ) : null,
  },
};
