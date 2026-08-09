import { useState, useCallback, useMemo } from 'react';
import { ArrowLeft, Plus, RefreshCw, Upload, Trash2, Search, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { Skeleton } from '../ui/skeleton';
import type { Agent, EnvFileInfo } from '../../types';
import { EnvUploadDialog } from './EnvUploadDialog';
import { EnvInlineEditor } from './EnvInlineEditor';
import { sourceLabel } from './envRef';
import { useEnvManager } from './useEnvManager';

// ── Left panel: file list ──────────────────────────────────────────────

function FileListItem({
  file,
  isSelected,
  onSelect,
  onDelete,
}: {
  file: EnvFileInfo;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const timeAgo = useMemo(() => {
    const diff = Date.now() - file.modified * 1000;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) { return 'just now'; }
    if (mins < 60) { return `${mins}m ago`; }
    const hours = Math.floor(mins / 60);
    if (hours < 24) { return `${hours}h ago`; }
    return `${Math.floor(hours / 24)}d ago`;
  }, [file.modified]);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-accent/50 transition-colors',
        isSelected && 'bg-accent',
      )}
    >
      <FileText className={cn(
        'w-4 h-4 flex-shrink-0',
        isSelected ? 'text-primary' : 'text-muted-foreground',
      )} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{file.name}</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <Badge variant="outline" className="text-[10px] px-1 py-0 leading-none">
            {sourceLabel(file)}
          </Badge>
          <span className="text-[10px] text-muted-foreground">
            {file.var_count}v · {file.size}B · {timeAgo}
          </span>
        </div>
      </div>
      <Button
        size="sm" variant="ghost"
        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive flex-shrink-0 opacity-0 group-hover:opacity-100"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </Button>
    </button>
  );
}

// ── Left panel: file list panel ─────────────────────────────────────────

function FileListPanel({ files, loading, search, onSearchChange, selected, isNew, cloneTarget, onSelect, onDelete, onNew, className }: {
  files: ReturnType<typeof useEnvManager>['files'];
  loading: boolean;
  search: string;
  onSearchChange: (v: string) => void;
  selected: EnvFileInfo | null;
  isNew: boolean;
  cloneTarget: EnvFileInfo | null;
  onSelect: (f: EnvFileInfo) => void;
  onDelete: (f: EnvFileInfo) => void;
  onNew: () => void;
  className?: string;
}) {
  const filtered = useMemo(() => {
    if (!search.trim()) { return files; }
    const q = search.toLowerCase();
    return files.filter((f) =>
      f.name.toLowerCase().includes(q) || sourceLabel(f).toLowerCase().includes(q),
    );
  }, [files, search]);

  return (
    <div className={cn('flex flex-col flex-shrink-0', className)}>
      <div className="p-2 border-b">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input placeholder="Filter files…" value={search} onChange={(e) => onSearchChange(e.target.value)}
            className="pl-8 h-8 text-xs" />
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {loading ? (
          <div className="flex flex-col p-2 gap-1">
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 w-full rounded" />)}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8 px-2">
            {files.length === 0 ? 'No env files yet' : 'No files match'}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((f) => (
              <FileListItem
                key={`${f.source}:${f.agent_id ?? ''}:${f.name}`}
                file={f}
                isSelected={!isNew && !cloneTarget && selected?.name === f.name && selected?.source === f.source}
                onSelect={() => onSelect(f)}
                onDelete={() => onDelete(f)}
              />
            ))}
          </div>
        )}
      </ScrollArea>
      <div className="p-2 border-t">
        <Button size="sm" className="w-full" onClick={onNew}>
          <Plus className="w-3.5 h-3.5 mr-1" /> New File
        </Button>
      </div>
    </div>
  );
}

// ── Main layout ─────────────────────────────────────────────────────────

interface EnvManagerProps {
  agents: Agent[];
  onBack: () => void;
}

export function EnvManager({ agents, onBack }: EnvManagerProps) {
  const { files, loading, refresh, deleteFile, uploadFile } = useEnvManager();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<EnvFileInfo | null>(null);
  const [cloneTarget, setCloneTarget] = useState<EnvFileInfo | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const handleSaved = useCallback(() => {
    refresh();
    setIsNew(false);
    setCloneTarget(null);
  }, [refresh]);

  const handleDeleted = useCallback(() => {
    refresh();
    setSelected(null);
  }, [refresh]);

  const selectFile = useCallback((f: EnvFileInfo) => {
    setSelected(f);
    setIsNew(false);
    setCloneTarget(null);
  }, []);

  const startNew = useCallback(() => {
    setSelected(null);
    setCloneTarget(null);
    setIsNew(true);
  }, []);

  const startClone = useCallback(() => {
    if (!selected) { return; }
    setCloneTarget(selected);
    setIsNew(false);
  }, [selected]);

  const handleDeleteFromList = useCallback((f: EnvFileInfo) => {
    deleteFile(f);
    if (selected?.name === f.name && selected?.source === f.source) {
      setSelected(null);
    }
  }, [deleteFile, selected]);

  const hasDetail = selected !== null || isNew || cloneTarget !== null;
  const backToList = useCallback(() => {
    setSelected(null);
    setIsNew(false);
    setCloneTarget(null);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Top bar — simplified on mobile when detail is active */}
      <header className="border-b px-3 sm:px-4 py-2 sm:py-2.5 flex items-center gap-2 sm:gap-3 flex-shrink-0">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" /> <span className="max-sm:hidden">Back</span>
        </Button>
        <h1 className="text-sm sm:text-base font-bold truncate">Env Files</h1>
        <span className="text-xs text-muted-foreground max-sm:hidden">({files.length})</span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
          <Upload className="w-3.5 h-3.5 sm:mr-1" /> <span className="max-sm:hidden">Upload</span>
        </Button>
        <Button size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </Button>
      </header>

      {/* Split panel — responsive: stacked on mobile, side-by-side on desktop */}
      <div className="flex-1 flex min-h-0">
        {/* File list: hidden on mobile when detail is shown */}
        <FileListPanel
          className={cn(
            'w-full border-r md:w-64',
            hasDetail ? 'max-md:hidden' : 'max-md:flex',
          )}
          files={files} loading={loading} search={search}
          onSearchChange={setSearch} selected={selected}
          isNew={isNew} cloneTarget={cloneTarget}
          onSelect={selectFile} onDelete={handleDeleteFromList}
          onNew={startNew}
        />

        {/* Editor: visible on mobile only when detail active */}
        <div className={cn('flex-1 flex flex-col min-w-0', !hasDetail && 'max-md:hidden')}>
          {/* Mobile back-to-list bar */}
          {hasDetail && (
            <div className="md:hidden px-3 py-1.5 border-b flex items-center flex-shrink-0">
              <Button variant="ghost" size="sm" onClick={backToList}>
                <ArrowLeft className="w-4 h-4 mr-1" /> Files
              </Button>
            </div>
          )}
          <EnvInlineEditor
            file={(!isNew && !cloneTarget) ? selected : null}
            cloneFrom={cloneTarget}
            isNew={isNew}
            agents={agents}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
            onClone={startClone}
            onNew={startNew}
          />
        </div>
      </div>

      <EnvUploadDialog
        isOpen={uploadOpen}
        onClose={() => setUploadOpen(false)}
        agents={agents}
        onUpload={async (file, source, agentId) => {
          await uploadFile({ file, source, agentId });
        }}
      />
    </div>
  );
}
