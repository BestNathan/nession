import { UserRound } from 'lucide-react';
import type { WorkspaceViewBinding } from '../workspaceContext';
import { AppToolScroll } from '../AppToolScroll';
import { AgentDetail } from '@/product/agent/components/AgentDetail';

export const agentView: WorkspaceViewBinding = {
  id: 'agent',
  icon: UserRound,
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
