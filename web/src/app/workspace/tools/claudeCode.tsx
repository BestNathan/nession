import { Bot } from 'lucide-react';
import { ClaudeCodeWorkspace } from '@/extensions/claude-code/components/ClaudeCodeWorkspace';
import type { WorkspaceTool } from '../toolTypes';

export const claudeCodeTool: WorkspaceTool = {
  id: 'claude-code',
  label: 'Claude Code',
  icon: Bot,
  order: 40,
  availability: () => true,
  layout: {
    web: ({ ctx }) => <ClaudeCodeWorkspace ctx={ctx} />,
    app: ({ ctx }) => <ClaudeCodeWorkspace ctx={ctx} />,
  },
};
