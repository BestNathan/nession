import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Copy, Trash2, FileText, Eye, EyeOff, Clock, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { ScrollArea } from '../ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
import type { Agent, EnvFileInfo, EnvSource } from '../../types';
import { EnvDiff } from './EnvDiff';
import { parseEnv } from '@/lib/envParser';
import { sourceLabel } from './envRef';
import { useWebSocket } from '../../hooks/useWebSocket';

const PLACEHOLDER =
  '# KEY=VALUE pairs, one per line\n# Lines starting with # are comments\nAPI_URL=https://api.example.com\nDEBUG=false\n';

interface EditorState {
  name: string; source: EnvSource; agentId: string;
  content: string; originalContent: string;
  loading: boolean; error: string | null;
  hideSecrets: boolean; inUseBy: string[];
  isEdit: boolean;
}

interface EnvInlineEditorProps {
  file: EnvFileInfo | null;
  cloneFrom: EnvFileInfo | null;
  isNew: boolean;
  agents: Agent[];
  onSaved: () => void;
  onDeleted: () => void;
  onClone: () => void;
  onNew: () => void;
}

// ── Previews (parse + diff + in-use warning) ────────────────────────────

function EditorPreviews({ state, parsed, hasWarnings, hasDiff }: {
  state: EditorState;
  parsed: ReturnType<typeof parseEnv>;
  hasWarnings: boolean;
  hasDiff: boolean;
}) {
  return (
    <>
      <details className="flex flex-col gap-1" open={hasWarnings}>
        <summary className="cursor-pointer text-xs text-muted-foreground font-medium select-none">
          Parsed Variables ({parsed.vars.length})
          {hasWarnings && <span className="ml-2 text-warning">{parsed.warnings.length} warning{parsed.warnings.length !== 1 ? 's' : ''}</span>}
        </summary>
        <div className="mt-1.5 rounded-md border max-h-40 overflow-y-auto">
          {parsed.warnings.map((w, i) => (
            <p key={i} className="text-[11px] text-warning px-2 py-0.5 font-mono">⚠️ {w}</p>
          ))}
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-2 py-1 font-medium text-muted-foreground">Variable</th>
                <th className="text-left px-2 py-1 font-medium text-muted-foreground">Value</th>
                <th className="text-right px-2 py-1 font-medium text-muted-foreground w-12">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {parsed.vars.map(([k, v]) => (
                <tr key={k}>
                  <td className="px-2 py-0.5 font-mono">{k}</td>
                  <td className="px-2 py-0.5 font-mono text-muted-foreground">
                    {v.length > 40 ? v.slice(0, 40) + '…' : (v || <span className="italic">(empty)</span>)}
                  </td>
                  <td className="px-2 py-0.5 text-right">✅</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {state.isEdit && (
        <details className="flex flex-col gap-1">
          <summary className="cursor-pointer text-xs text-muted-foreground font-medium select-none">
            Preview Changes{hasDiff && <span className="ml-1.5 text-primary">•</span>}
          </summary>
          <div className="mt-1.5">
            <EnvDiff original={state.originalContent} modified={state.content} />
          </div>
        </details>
      )}

      {state.inUseBy.length > 0 && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 gap-1">
          <p className="text-sm text-destructive font-medium">In use by {state.inUseBy.length} session(s)</p>
          <p className="text-xs text-muted-foreground">Forcing will re-source in: {state.inUseBy.join(', ')}</p>
        </div>
      )}
    </>
  );
}

// ── Editor form body (content area) ─────────────────────────────────────

function EditorFormBody({
  state, set, onlineAgents, parsed, hasWarnings, hasDiff,
}: {
  state: EditorState;
  set: <K extends keyof EditorState>(k: K, v: EditorState[K]) => void;
  onlineAgents: Agent[];
  parsed: ReturnType<typeof parseEnv>;
  hasWarnings: boolean;
  hasDiff: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="flex flex-col p-4 gap-4">
      {/* Name + source + agent */}
      <div className="flex gap-3 items-end">
        {!state.isEdit && (
          <div className="flex flex-col gap-1.5 flex-[2] min-w-0">
            <Label className="text-xs">File Name</Label>
            <Input
              value={state.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="staging.env" disabled={state.loading}
              autoComplete="off" className="h-9"
            />
          </div>
        )}
        <div className={cn('gap-1.5 min-w-0', state.isEdit ? 'flex-1' : 'flex-[1]')}>
          <Label className="text-xs">Location</Label>
          <Select value={state.source} onValueChange={(v) => v && set('source', v as EnvSource)} disabled={state.loading}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="server">Server</SelectItem>
              <SelectItem value="agent">Agent</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {state.source === 'agent' && (
          <div className="flex flex-col gap-1.5 flex-[1] min-w-0">
            <Label className="text-xs">Agent</Label>
            <Select value={state.agentId} onValueChange={(v) => { if (v) { set('agentId', v); } }} disabled={state.loading}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select agent" /></SelectTrigger>
              <SelectContent>
                {onlineAgents.map((a) => (
                  <SelectItem key={a.agent_id} value={a.agent_id}>{a.hostname} ({a.agent_id})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Textarea */}
      <div className="flex flex-col gap-1.5 flex flex-col flex-1 min-h-[300px]">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Content</Label>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs"
            onClick={() => set('hideSecrets', !state.hideSecrets)}>
            {state.hideSecrets
              ? <><EyeOff className="w-3.5 h-3.5 mr-1" /> Show Secrets</>
              : <><Eye className="w-3.5 h-3.5 mr-1" /> Hide Secrets</>}
          </Button>
        </div>
        <div className="relative flex-1 min-h-[300px]">
          <Textarea
            ref={textareaRef}
            value={state.content}
            onChange={(e) => set('content', e.target.value)}
            placeholder={PLACEHOLDER} disabled={state.loading}
            className="font-mono text-xs h-full min-h-[300px] resize-none"
            spellCheck={false}
          />
          {state.hideSecrets && (
            <div
              className="absolute inset-0 font-mono text-xs p-3 pointer-events-none whitespace-pre-wrap break-all overflow-hidden bg-background"
              aria-hidden="true"
            >
              {state.content.split('\n').map((line, i) => {
                const eqIdx = line.indexOf('=');
                if (eqIdx === -1) { return <span key={i}>{line}{'\n'}</span>; }
                if (/(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(line.slice(0, eqIdx).trim())) {
                  return <span key={i}>{line.slice(0, eqIdx + 1)}<span className="text-muted-foreground">********</span>{'\n'}</span>;
                }
                return <span key={i}>{line}{'\n'}</span>;
              })}
            </div>
          )}
        </div>
      </div>

      <EditorPreviews state={state} parsed={parsed} hasWarnings={hasWarnings} hasDiff={hasDiff} />

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
    </div>
  );
}

// ── Footer actions ──────────────────────────────────────────────────────

function EditorFooter({
  state, file, wsService, loading, onSaved, onDeleted, onClone, doSave,
}: {
  state: EditorState;
  file: EnvFileInfo | null;
  wsService: ReturnType<typeof useWebSocket>;
  loading: boolean;
  onSaved: () => void;
  onDeleted: () => void;
  onClone: () => void;
  doSave: (overwrite: boolean, force?: boolean) => Promise<void>;
}) {
  return (
    <div className="border-t px-4 py-2.5 flex items-center gap-2 flex-shrink-0">
      {state.isEdit && file && (
        <>
          <Button size="sm" variant="outline" onClick={onClone} disabled={loading}>
            <Copy className="w-3.5 h-3.5 mr-1" /> Clone
          </Button>
          <Button size="sm" variant="outline" className="text-destructive border-destructive hover:bg-destructive/10"
            onClick={() => {
              if (!file) { return; }
              if (!window.confirm(`Delete ${file.name}? This cannot be undone.`)) { return; }
              wsService.deleteEnvFile({ name: file.name, source: file.source, agent_id: file.agent_id ?? undefined })
                .then((r) => {
                  if (r.success) { onDeleted(); }
                  else { toast.error(r.error ?? 'Failed to delete'); }
                })
                .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Failed to delete'));
            }} disabled={loading}>
            <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
          </Button>
          <div className="flex-1" />
        </>
      )}
      {!state.isEdit && <div className="flex-1" />}
      <Button size="sm" variant="outline" onClick={onSaved} disabled={loading}>Cancel</Button>
      {state.inUseBy.length > 0 ? (
        <Button size="sm" variant="destructive" onClick={() => doSave(true, true)} disabled={loading}>
          {loading ? 'Saving…' : 'Force Save'}
        </Button>
      ) : (
        <Button size="sm" onClick={() => doSave(state.isEdit, false)} disabled={loading}>
          {loading ? 'Saving…' : 'Save'}
        </Button>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────

export function EnvInlineEditor({
  file, cloneFrom, isNew, agents, onSaved, onDeleted, onClone, onNew,
}: EnvInlineEditorProps) {
  const wsService = useWebSocket();
  const [state, setState] = useState<EditorState>({
    name: '', source: 'server', agentId: '', content: '', originalContent: '',
    loading: false, error: null, hideSecrets: false, inUseBy: [], isEdit: false,
  });

  const set = useCallback(<K extends keyof EditorState>(k: K, v: EditorState[K]) => {
    setState((prev) => ({ ...prev, [k]: v }));
  }, []);

  // Load file content when selection changes
  useEffect(() => {
    if (cloneFrom) {
      setState((prev) => ({
        ...prev, name: `${cloneFrom.name.replace(/\.env$/, '')}-copy.env`,
        source: cloneFrom.source, agentId: cloneFrom.agent_id ?? '',
        content: '', originalContent: '', loading: true, error: null,
        hideSecrets: false, inUseBy: [], isEdit: false,
      }));
      wsService.getEnvFile({ name: cloneFrom.name, source: cloneFrom.source, agent_id: cloneFrom.agent_id })
        .then((r) => { if (r.success) { set('content', r.content ?? ''); set('loading', false); } })
        .catch(() => set('error', 'Failed to load'));
      return;
    }
    if (file) {
      setState((prev) => ({
        ...prev, name: file.name, source: file.source, agentId: file.agent_id ?? '',
        content: '', originalContent: '', loading: true, error: null,
        hideSecrets: true, inUseBy: [], isEdit: true,
      }));
      wsService.getEnvFile({ name: file.name, source: file.source, agent_id: file.agent_id })
        .then((r) => {
          if (r.success) {
            setState((prev) => ({
              ...prev, content: r.content ?? '', originalContent: r.content ?? '',
              loading: false, hideSecrets: true, inUseBy: r.in_use_by ?? [], isEdit: true,
            }));
          } else { set('error', r.error ?? 'Failed to load'); }
        })
        .catch(() => set('error', 'Failed to load'));
      return;
    }
    const firstOnline = agents.find((a) => a.status === 'online');
    setState((prev) => ({
      ...prev, name: '', source: 'server', agentId: firstOnline?.agent_id ?? '',
      content: '', originalContent: '', loading: false, error: null,
      hideSecrets: false, inUseBy: [], isEdit: false,
    }));
  }, [file?.name, file?.source, file?.agent_id, cloneFrom?.name, cloneFrom?.source, cloneFrom?.agent_id, isNew, wsService, agents, set]); // eslint-disable-line react-hooks/exhaustive-deps

  const buildRef = () => {
    const fileName = state.name.trim().endsWith('.env') ? state.name.trim() : `${state.name.trim()}.env`;
    return { name: fileName, source: state.source, agent_id: state.source === 'agent' ? state.agentId : undefined };
  };

  const doSave = async (overwrite: boolean, force = false) => {
    if (!state.name.trim()) { set('error', 'File name is required'); return; }
    if (state.source === 'agent' && !state.agentId) { set('error', 'Select an agent'); return; }
    set('loading', true);
    set('error', null);
    try {
      const resp = await wsService.writeEnvFile(buildRef(), state.content, overwrite, force);
      if (resp.success) {
        if (resp.re_sourced?.length) { toast.success(`Re-sourced in ${resp.re_sourced.length} session(s)`); }
        resp.re_source_errors?.forEach((e: string) => toast.error(`Re-source failed: ${e}`));
        onSaved();
      } else if (resp.exists) {
        if (window.confirm('File already exists. Overwrite?')) { await doSave(true, force); }
      } else {
        set('error', resp.error ?? 'Failed to save');
      }
    } catch (e) {
      set('error', e instanceof Error ? e.message : 'Failed to save');
    } finally {
      set('loading', false);
    }
  };

  const onlineAgents = useMemo(() => agents.filter((a) => a.status === 'online'), [agents]);
  const parsed = useMemo(() => parseEnv(state.content), [state.content]);
  const hasWarnings = parsed.warnings.length > 0;
  const hasDiff = state.isEdit && state.content !== state.originalContent;
  const loading = state.loading;

  // Empty state
  if (!file && !cloneFrom && !isNew) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
        <FileText size={48} className="opacity-20" />
        <p className="text-sm">Select a file from the list or create a new one</p>
        <Button size="sm" onClick={onNew}><Plus className="w-3.5 h-3.5 mr-1" /> New File</Button>
      </div>
    );
  }

  const title = cloneFrom ? `Clone: ${cloneFrom.name}`
    : state.isEdit ? `Edit: ${file?.name}`
    : 'New Env File';

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-3 border-b flex items-center gap-3 flex-shrink-0">
        <h2 className="text-sm font-semibold truncate">{title}</h2>
        {state.isEdit && file && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground ml-auto">
            <Badge variant="outline" className="text-[10px]">{sourceLabel(file)}</Badge>
            <span>{file.var_count} vars</span>
            <span>·</span>
            <span>{file.size} bytes</span>
            <span>·</span>
            <Clock className="w-3 h-3" />
            <span>{new Date(file.modified * 1000).toLocaleDateString()}</span>
          </div>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <EditorFormBody state={state} set={set} onlineAgents={onlineAgents}
          parsed={parsed} hasWarnings={hasWarnings} hasDiff={hasDiff} />
      </ScrollArea>

      <EditorFooter state={state} file={file} wsService={wsService} loading={loading}
        onSaved={onSaved} onDeleted={onDeleted} onClone={onClone} doSave={doSave} />
    </div>
  );
}
