import { useState, useEffect, useCallback } from 'react';
import { Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { claudeCodeApi } from '@/features/claude-code';
import { ConfigViewer } from './ConfigViewer';
import type { TerminalHeaderSlotProps } from '../../types';
import type { ConfigCategory, ClaudeCodeListResponse } from '../types';

export function TerminalClaudeCodeTab({ sessionId }: TerminalHeaderSlotProps) {
  const [categories, setCategories] = useState<ConfigCategory[]>([]);
  const [available, setAvailable] = useState<boolean>(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const agentId = sessionId.split(':')[0];

  const fetchConfig = useCallback(async () => {
    try {
      const resp: ClaudeCodeListResponse = await claudeCodeApi.claudeCodeList({ agent_id: agentId, scope: 'project', session_id: sessionId });
      setAvailable(resp.available);
      setCategories(resp.categories);
    } catch {
      setAvailable(false);
    }
  }, [agentId, sessionId]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  if (!available) {
    return null;
  }

  return (
    <>
      <button onClick={() => setViewerOpen(true)}
        className={cn('flex items-center gap-1 px-3 py-1.5 text-xs border-r border-b-2 transition-colors flex-shrink-0',
          'border-b-transparent text-muted-foreground hover:text-foreground')}
        title="Project Claude Code config">
        <Settings className="h-3 w-3" /> CC
      </button>
      <ConfigViewer
        open={viewerOpen}
        onClose={() => setViewerOpen(false)}
        categories={categories}
        agentId={agentId}
        scope="project"
        sessionId={sessionId}
      />
    </>
  );
}
