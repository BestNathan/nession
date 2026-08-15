import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';
import { Play, X, FileText, RefreshCw, Check, CheckSquare, Square, Pencil } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import type { EnvFileInfo } from '../../types';
import type { WebSocketService } from '../../services/websocket';
import { refKey, toRef, sourceLabel } from './envRef';
import { EnvEditorDialog } from './EnvEditorDialog';
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

// ── Selection + batch actions (extracted to keep EnvPanel under the 120-line limit) ──

function useEnvSelection({
  wsService,
  sessionId,
  files,
  setBusy,
  refresh,
}: {
  wsService: WebSocketService;
  sessionId: string;
  files: EnvFileInfo[];
  setBusy: Dispatch<SetStateAction<Set<string>>>;
  refresh: () => void;
}) {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSelectMode = () => {
    setSelectMode((prev) => !prev);
    setSelected(new Set());
  };

  const toggleFileSelect = (file: EnvFileInfo) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = refKey(file);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const batchAction = useCallback(
    async (action: 'source' | 'unsource') => {
      const selFiles = files.filter((f) => selected.has(refKey(f)));
      if (selFiles.length === 0) {
        return;
      }

      setBusy((prev) => {
        const next = new Set(prev);
        for (const f of selFiles) {
          next.add(refKey(f));
        }
        return next;
      });

      const results = await Promise.allSettled(
        selFiles.map((f) => {
          const ref = toRef(f);
          return action === 'source'
            ? wsService.applySessionEnv(sessionId, [ref])
            : wsService.unsetSessionEnv(sessionId, [ref]);
        }),
      );

      let ok = 0;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.success) {
          ok++;
        } else if (r.status === 'rejected') {
          toast.error(`Failed to ${action} ${selFiles[i].name}`);
        }
      });

      const verb = action === 'source' ? 'Sourced' : 'Unsourced';
      if (ok > 0) {
        toast.success(`${verb} ${ok}/${selFiles.length} files`);
      }

      setBusy((prev) => {
        const next = new Set(prev);
        for (const f of selFiles) {
          next.delete(refKey(f));
        }
        return next;
      });

      setSelectMode(false);
      setSelected(new Set());
      refresh();
    },
    [wsService, sessionId, files, selected, setBusy, refresh],
  );

  return { selectMode, selected, toggleSelectMode, toggleFileSelect, batchAction };
}

// ── Inline edit dialog (extracted to keep EnvPanel under the 120-line limit) ──

function useEnvEditDialog(
  refresh: () => void,
  sourced: Set<string>,
  action: (f: EnvFileInfo, a: 'source' | 'unsource') => void,
) {
  const [editingFile, setEditingFile] = useState<EnvFileInfo | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const open = useCallback((file: EnvFileInfo) => {
    setEditingFile(file);
    setEditorOpen(true);
  }, []);

  const close = useCallback(() => {
    setEditorOpen(false);
    setEditingFile(null);
  }, []);

  const onSaved = () => {
    refresh();
    // If the edited file was sourced, re-source it so the session sees the new content.
    if (editingFile && sourced.has(refKey(editingFile))) {
      action(editingFile, 'source');
    }
  };

  return { editingFile, editorOpen, open, close, onSaved };
}

// ── Row (extracted to keep EnvPanel under the 120-line limit) ──────────

function EnvFileRow({
  file,
  isSourced,
  isCreateTime,
  isBusy,
  onSource,
  onUnsource,
  selectMode,
  isSelected,
  onToggleSelect,
  showEdit,
  onEdit,
}: {
  file: EnvFileInfo;
  isSourced: boolean;
  isCreateTime: boolean;
  isBusy: boolean;
  onSource: (f: EnvFileInfo) => void;
  onUnsource: (f: EnvFileInfo) => void;
  selectMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  showEdit?: boolean;
  onEdit?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent/30 transition-colors">
      {selectMode && (
        <button type="button" onClick={onToggleSelect} className="flex-shrink-0" aria-label={`Select ${file.name}`}>
          {isSelected ? (
            <CheckSquare className="w-4 h-4 text-primary" />
          ) : (
            <Square className="w-4 h-4 text-muted-foreground" />
          )}
        </button>
      )}
      <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
      <span className="flex-1 text-xs truncate">{file.name}</span>
      <Badge variant="outline" className="text-[10px] px-1 py-0">
        {sourceLabel(file)}
      </Badge>
      <span className="text-[10px] text-muted-foreground w-8 text-right">{file.var_count}v</span>
      {showEdit && (
        <Button
          size="sm" variant="ghost"
          className="h-6 w-6 px-0"
          onClick={onEdit}
        >
          <Pencil className="w-3 h-3" />
        </Button>
      )}
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

// ── Batch action bar (extracted to keep EnvPanel under the 120-line limit) ──

function BatchActionBar({
  count,
  onSource,
  onUnsource,
}: {
  count: number;
  onSource: () => void;
  onUnsource: () => void;
}) {
  return (
    <div className="border-t px-3 py-1.5 flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground">{count} selected</span>
      <div className="flex-1" />
      <Button size="sm" className="h-6 px-2 text-[10px]" onClick={onSource}>
        <Play className="w-3 h-3 mr-0.5" /> Source
      </Button>
      <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={onUnsource}>
        <X className="w-3 h-3 mr-0.5" /> Unsource
      </Button>
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
      .then((resp) => setFiles(resp.files ?? []))
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
          const refs = resp.sourced_files ?? [];
          if (refs.length === 0) {
            return;
          }
          setSourced((prev) => {
            const next = new Set(prev);
            for (const ref of refs) {
              next.add(refKey(ref));
            }
            return next;
          });
        })
        .catch(() => undefined);
    }
  }, [refresh, sessionId, wsService]);

  const action = useEnvActions(undefined, sessionId, setSourced, setBusy);
  const edit = useEnvEditDialog(refresh, sourced, action);

  const { selectMode, selected, toggleSelectMode, toggleFileSelect, batchAction } = useEnvSelection({
    wsService,
    sessionId,
    files,
    setBusy,
    refresh,
  });

  const sourcedFiles = (files ?? []).filter((f) => sourced.has(refKey(f)));

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 border-b">
        <span className="text-xs font-medium text-muted-foreground">Env Files</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={toggleSelectMode}>
            {selectMode ? 'Cancel' : 'Select'}
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={refresh} disabled={loading}>
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
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
                onSource={(f) => action(f, 'source')}
                onUnsource={(f) => action(f, 'unsource')}
                selectMode={selectMode}
                isSelected={selected.has(refKey(file))}
                onToggleSelect={() => toggleFileSelect(file)}
                showEdit={!selectMode}
                onEdit={() => edit.open(file)}
              />
            ))}
          </div>
        )}
        {selectMode && selected.size > 0 && (
          <BatchActionBar
            count={selected.size}
            onSource={() => batchAction('source')}
            onUnsource={() => batchAction('unsource')}
          />
        )}
        {sourcedFiles.length > 0 && (
          <div className="border-t px-3 py-1">
            <span className="text-[10px] font-medium text-muted-foreground">
              {sourcedFiles.length} file{sourcedFiles.length !== 1 ? 's' : ''} sourced
            </span>
          </div>
        )}
      </ScrollArea>
      <EnvEditorDialog isOpen={edit.editorOpen} onClose={edit.close} editing={edit.editingFile} agents={[]} onSaved={edit.onSaved} />
    </div>
  );
}
