import { Bot } from 'lucide-react';
import { ClaudeCodeWorkspace } from '@/extensions/claude-code/components/ClaudeCodeWorkspace';
import type { WorkspaceViewBinding } from '../workspaceContext';

export const claudeCodeView: WorkspaceViewBinding = {
  id: 'claude-code',
  icon: Bot,
  layout: {
    web: ({ ctx }) => <ClaudeCodeWorkspace ctx={ctx} />,
    app: ({ ctx }) => <ClaudeCodeWorkspace ctx={ctx} />,
  },
};
