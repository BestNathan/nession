import { useState, useEffect, useCallback } from 'react';
import { FileText, BookOpen, Bot, Puzzle, History, Settings, FolderOpen } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { claudeCodeApi } from '@/features/claude-code';
import { ConfigViewer } from './ConfigViewer';
import type { AgentDetailSlotProps } from '../../types';
import type { ConfigCategory, ClaudeCodeListResponse } from '../types';

const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Settings,
  Instructions: BookOpen,
  Agents: Bot,
  Skills: Puzzle,
  History,
};

export function ClaudeCodeSection({ agent }: AgentDetailSlotProps) {
  const [categories, setCategories] = useState<ConfigCategory[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp: ClaudeCodeListResponse = await claudeCodeApi.claudeCodeList({ agent_id: agent.agent_id, scope: 'global' });
      setAvailable(resp.available);
      setCategories(resp.categories);
      if (resp.error) {
        setError(resp.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setAvailable(false);
    } finally {
      setLoading(false);
    }
  }, [agent.agent_id]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  if (loading) {
    return (
      <>
        <div className="flex items-center gap-2 py-1">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Claude Code</span>
        </div>
        <p className="text-xs text-muted-foreground animate-pulse">Loading...</p>
        <Separator />
      </>
    );
  }

  if (error && !available) {
    return (
      <>
        <div className="flex items-center gap-2 py-1">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Claude Code</span>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Configuration unavailable</p>
          <Button variant="ghost" size="sm" onClick={fetchConfig} className="h-6 text-xs">Retry</Button>
        </div>
        <Separator />
      </>
    );
  }

  if (!available) {
    return (
      <>
        <div className="flex items-center gap-2 py-1">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Claude Code</span>
        </div>
        <p className="text-xs text-muted-foreground">Claude Code not installed</p>
        <Separator />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2 py-1">
        <FolderOpen className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Claude Code</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(categories || []).map((cat) => {
          const Icon = CATEGORY_ICONS[cat.name] || FileText;
          return (
            <button key={cat.name} onClick={() => setViewerOpen(true)}
              className="flex flex-col items-start gap-1 p-2 rounded-md border bg-card hover:bg-accent transition-colors text-left">
              <div className="flex items-center gap-1.5">
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">{cat.name}</span>
              </div>
              <span className="text-[11px] text-muted-foreground">{cat.files.length} files</span>
            </button>
          );
        })}
      </div>
      <Separator />
      <ConfigViewer
        open={viewerOpen}
        onClose={() => setViewerOpen(false)}
        categories={categories || []}
        agentId={agent.agent_id}
        scope="global"
      />
    </>
  );
}
