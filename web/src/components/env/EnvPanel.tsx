import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';
import { Play, X, FileText, RefreshCw, Check } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import type { EnvFileInfo } from '../../types';
import type { WebSocketService } from '../../services/websocket';
import { refKey, toRef, sourceLabel } from './envRef';
import { useWebSocket } from '../../hooks/useWebSocket';

interface EnvPanelProps {
  sessionId: string;
}

// ── Helpers (extracted to keep EnvPanel under the 120-line limit) ────────

function useEnvActions(
  _wsService: WebSocketService | undefined,
  sessionId: string,
  setSourced: Dispatch<SetStateAction<Set<string>>>,
  setBusy: Dispatch<SetStateAction<Set<string>>>,
) {
  const wsService = useWebSocket(_wsService);
  return useCallback(
    (file: EnvFileInfo, action: 'source' | 'unsource') => {
      const ref = toRef(file);
      const key = refKey(ref);
      setBusy((prev) => new Set(prev).add(key));
      const promise =
        action === 'source'
          ? wsService.applySessionEnv(sessionId, [ref])
          : wsService.unsetSessionEnv(sessionId, [ref]);
      promise
        .then((resp) => {
          if (resp.success) {
            setSourced((prev) => {
              const next = new Set(prev);
              if (action === 'source') {
                next.add(key);
              } else {
                next.delete(key);
              }
              return next;
            });
            const warns = resp.warnings ?? [];
            if (action === 'source' && warns.length > 0) {
              toast.warning(`Sourced ${file.name} with warnings: ${warns.join('; ')}`);
            }
          } else {
            const verb = action === 'source' ? 'source' : 'unsource';
            toast.error(resp.error ?? `Failed to ${verb} ${file.name}`);
          }
        })
        .catch((err) => {
          const verb = action === 'source' ? 'source' : 'unsource';
          toast.error(err instanceof Error ? err.message : `Failed to ${verb} ${file.name}`);
        })
        .finally(() => {
          setBusy((prev) => { const next = new Set(prev); next.delete(key); return next; });
        });
    },
    [wsService, sessionId, setSourced, setBusy],
  );
}

// ── Row (extracted to keep EnvPanel under the 120-line limit) ──────────

function EnvFileRow({
  file,
  isSourced,
  isCreateTime,
  isBusy,
  onSource,
  onUnsource,
}: {
  file: EnvFileInfo;
  isSourced: boolean;
  isCreateTime: boolean;
  isBusy: boolean;
  onSource: (f: EnvFileInfo) => void;
  onUnsource: (f: EnvFileInfo) => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent/30 transition-colors">
      <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
      <span className="flex-1 text-xs truncate">{file.name}</span>
      <Badge variant="outline" className="text-[10px] px-1 py-0">
        {sourceLabel(file)}
      </Badge>
      <span className="text-[10px] text-muted-foreground w-8 text-right">{file.var_count}v</span>
      {isSourced ? (
        isCreateTime ? (
          <span className="h-6 w-6 flex items-center justify-center text-emerald-500" title="Applied at session creation">
            <Check className="w-3.5 h-3.5" />
          </span>
        ) : (
          <Button
            size="sm" variant="ghost"
            className="h-6 px-1.5 text-[10px] text-destructive hover:text-destructive"
            onClick={() => onUnsource(file)} disabled={isBusy}
          >
            <X className="w-3 h-3" />
          </Button>
        )
      ) : (
        <Button
          size="sm" variant="ghost"
          className="h-6 px-1.5 text-[10px]"
          onClick={() => onSource(file)} disabled={isBusy}
        >
          <Play className="w-3 h-3 mr-0.5" /> Source
        </Button>
      )}
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────

/**
 * In-terminal env-file management panel. Lists available env files and lets
 * the user source them (send-keys "source /tmp/script.sh") or unsource them
 * (send-keys "source /tmp/unsource.sh"). Sourced files are tracked locally.
 */
export function EnvPanel({ sessionId }: EnvPanelProps) {
  const wsService = useWebSocket();
  const [files, setFiles] = useState<EnvFileInfo[]>([]);
  const [sourced, setSourced] = useState<Set<string>>(new Set());
  const [createTimeKeys, setCreateTimeKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    setLoading(true);
    wsService
      .listEnvFiles()
      .then((resp) => setFiles(resp.files))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to list env files'))
      .finally(() => setLoading(false));
  }, [wsService]);

  useEffect(() => {
    refresh();
    const agentId = sessionId.split(':')[0] ?? '';
    // Pre-mark env files applied at session create time as already sourced.
    wsService
      .getSessionEnvActive(sessionId)
      .then((resp) => {
        const ck = resp.active
          .filter((a) => a.phase === 'create')
          .map((a) => refKey(a));
        if (ck.length > 0) {
          setCreateTimeKeys(new Set(ck));
          setSourced((prev) => {
            const next = new Set(prev);
            for (const k of ck) { next.add(k); }
            return next;
          });
        }
      })
      .catch(() => undefined);
    // Query the agent for currently sourced env files.
    if (agentId) {
      wsService
        .queryAgentEnvState(sessionId)
        .then((resp) => {
          const names = resp.sourced_files ?? [];
          if (names.length === 0) {
            return;
          }
          setSourced((prev) => {
            const next = new Set(prev);
            for (const name of names) {
              next.add(refKey({ name, source: 'agent', agent_id: agentId }));
            }
            return next;
          });
        })
        .catch(() => undefined);
    }
  }, [refresh, sessionId, wsService]);

  const action = useEnvActions(undefined, sessionId, setSourced, setBusy);
  const source = useCallback((f: EnvFileInfo) => action(f, 'source'), [action]);
  const unsource = useCallback((f: EnvFileInfo) => action(f, 'unsource'), [action]);

  const sourcedFiles = files.filter((f) => sourced.has(refKey(f)));

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 border-b">
        <span className="text-xs font-medium text-muted-foreground">Env Files</span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={refresh} disabled={loading}>
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {files.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            No env files available. Create one in the Env Files page.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {files.map((file) => (
              <EnvFileRow
                key={refKey(file)}
                file={file}
                isSourced={sourced.has(refKey(file))}
                isCreateTime={createTimeKeys.has(refKey(file))}
                isBusy={busy.has(refKey(file))}
                onSource={source}
                onUnsource={unsource}
              />
            ))}
          </div>
        )}
        {sourcedFiles.length > 0 && (
          <div className="border-t px-3 py-1">
            <span className="text-[10px] font-medium text-muted-foreground">
              {sourcedFiles.length} file{sourcedFiles.length !== 1 ? 's' : ''} sourced
            </span>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
