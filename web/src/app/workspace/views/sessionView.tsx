import { Settings2 } from 'lucide-react';
import type { WorkspaceViewBinding } from '../workspaceContext';
import { AppToolScroll } from '../AppToolScroll';
import { SessionDetails } from '@/product/session/components/SessionDetails';

export const sessionView: WorkspaceViewBinding = {
  id: 'session',
  icon: Settings2,
  layout: {
    web: ({ ctx }) => (ctx.session && ctx.domain ? <SessionDetails session={ctx.session} state={ctx.domain} /> : null),
    app: ({ ctx }) =>
      ctx.session && ctx.domain ? (
        <AppToolScroll data-testid="session-details-app">
          <SessionDetails session={ctx.session} state={ctx.domain} />
        </AppToolScroll>
      ) : null,
  },
};
