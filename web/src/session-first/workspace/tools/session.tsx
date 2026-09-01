import { Settings2 } from 'lucide-react';
import type { WorkspaceTool } from '../toolTypes';
import { SessionDetails } from '@/session-first/SessionDetails';

export const sessionTool: WorkspaceTool = {
  id: 'session',
  label: 'Session',
  icon: Settings2,
  order: 20,
  availability: () => true,
  layout: {
    web: ({ ctx }) => (ctx.session && ctx.domain ? <SessionDetails session={ctx.session} state={ctx.domain} /> : null),
    app: ({ ctx }) => (ctx.session && ctx.domain ? <SessionDetails session={ctx.session} state={ctx.domain} /> : null),
  },
};
