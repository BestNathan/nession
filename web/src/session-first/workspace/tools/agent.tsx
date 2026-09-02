import { UserRound } from 'lucide-react';
import type { WorkspaceTool } from '../toolTypes';
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
        <div
          data-testid="agent-detail-app"
          className="h-full min-h-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]"
        >
          <AgentDetail agent={ctx.agent} state={ctx.domain} />
        </div>
      ) : null,
  },
};
