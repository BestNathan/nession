import type { UIExtension } from '../types';
import { ClaudeCodeSection } from './components/ClaudeCodeSection';
import { TerminalClaudeCodeTab } from './components/TerminalClaudeCodeTab';

const extension: UIExtension = {
  name: 'claude-code',
  slots: {
    'agent-detail': ClaudeCodeSection,
    'terminal-header': TerminalClaudeCodeTab,
  },
};

export default extension;
