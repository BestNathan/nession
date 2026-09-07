import { FileCog } from 'lucide-react';
import { EnvManager } from '@/components/env/EnvManager';
import type { WorkspaceTool } from '../toolTypes';
import { AppToolScroll } from '../AppToolScroll';

export const envFilesTool: WorkspaceTool = {
  id: 'env',
  label: 'Env',
  icon: FileCog,
  order: 25,
  availability: () => true,
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
