import { useState, useEffect, useCallback, useMemo } from 'react';
import { Settings } from 'lucide-react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { createClaudeCodeService } from '../services/claudeCodeService';
import { ConfigViewer } from './ConfigViewer';
import type { TerminalHeaderSlotProps } from '../../types';
import type { ConfigCategory, ClaudeCodeListResponse } from '../types';

export function TerminalClaudeCodeTab({ sessionId }: TerminalHeaderSlotProps) {
  const ws = useWebSocket();
  const service = useMemo(() => createClaudeCodeService(ws), [ws]);
  const [categories, setCategories] = useState<ConfigCategory[]>([]);
  const [available, setAvailable] = useState<boolean>(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const agentId = sessionId.split(':')[0];

  const fetchConfig = useCallback(async () => {
    try {
      const resp: ClaudeCodeListResponse = await service.list({ agent_id: agentId, scope: 'project', session_id: sessionId });
      setAvailable(resp.available);
      setCategories(resp.categories);
    } catch {
      setAvailable(false);
    }
  }, [agentId, sessionId, service]);

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
        service={service}
        agentId={agentId}
        scope="project"
        sessionId={sessionId}
      />
    </>
  );
}
