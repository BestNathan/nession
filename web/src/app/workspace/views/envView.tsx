import { FileCog } from 'lucide-react';
import { EnvManager } from '@/features/env/components/EnvManager';
import type { WorkspaceViewBinding } from '../workspaceContext';
import { AppToolScroll } from '../AppToolScroll';

export const envView: WorkspaceViewBinding = {
  id: 'env',
  icon: FileCog,
  layout: {
    web: ({ ctx }) => (
      <EnvManager agents={ctx.agents} embedded />
    ),
    app: ({ ctx }) => (
      <AppToolScroll data-testid="env-workspace-app">
        <EnvManager agents={ctx.agents} embedded />
      </AppToolScroll>
    ),
  },
};
