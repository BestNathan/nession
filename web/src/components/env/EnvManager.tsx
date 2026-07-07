import { useState, useRef } from 'react';
import { ArrowLeft, Plus, RefreshCw, Upload, Trash2, Pencil, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { Skeleton } from '../ui/skeleton';
import type { Agent, EnvFileInfo } from '../../types';
import type { WebSocketService } from '../../services/websocket';
import { EnvEditorDialog } from './EnvEditorDialog';
import { sourceLabel } from './envRef';
import { useEnvManager } from './useEnvManager';

interface EnvManagerProps {
  wsService: WebSocketService;
  agents: Agent[];
  onBack: () => void;
}

function EnvFileRow({
  file,
  onEdit,
  onDelete,
}: {
  file: EnvFileInfo;
  onEdit: (f: EnvFileInfo) => void;
  onDelete: (f: EnvFileInfo) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-3 px-4 hover:bg-accent/40 transition-colors">
      <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium text-sm truncate">{file.name}</p>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {sourceLabel(file)}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {file.var_count} var{file.var_count !== 1 ? 's' : ''} · {file.size} bytes
        </p>
      </div>
      <div className="flex gap-1.5 flex-shrink-0">
        <Button size="sm" variant="outline" onClick={() => onEdit(file)}>
          <Pencil className="w-3.5 h-3.5" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onDelete(file)}
          className="text-destructive border-destructive hover:bg-destructive/10"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function EnvManager({ wsService, agents, onBack }: EnvManagerProps) {
  const { files, loading, refresh, deleteFile, uploadFile } = useEnvManager(wsService);
  const [editing, setEditing] = useState<EnvFileInfo | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (file: EnvFileInfo) => {
    setEditing(file);
    setEditorOpen(true);
  };

  const onUploadChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void uploadFile(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="border-b px-6 py-3 flex items-center gap-4 flex-shrink-0">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <h1 className="text-lg font-bold">Env Files</h1>
        <div className="flex-1" />
        <input
          ref={fileInputRef}
          type="file"
          accept=".env,text/plain"
          className="hidden"
          onChange={onUploadChange}
        />
        <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
          <Upload className="w-3.5 h-3.5 mr-1" /> Upload
        </Button>
        <Button size="sm" onClick={openCreate}>
          <Plus className="w-3.5 h-3.5 mr-1" /> New
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
        </Button>
      </header>

      <div className="flex-1 min-h-0 p-6">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-md" />
            ))}
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-muted-foreground">
            <FileText size={32} className="mb-2" />
            <p className="text-sm">No env files yet. Create or upload one to get started.</p>
          </div>
        ) : (
          <ScrollArea className="h-full rounded-md border">
            <div className="divide-y divide-border">
              {files.map((file) => (
                <EnvFileRow
                  key={`${file.source}:${file.agent_id ?? ''}:${file.name}`}
                  file={file}
                  onEdit={openEdit}
                  onDelete={deleteFile}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      <EnvEditorDialog
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        wsService={wsService}
        editing={editing}
        agents={agents}
        onSaved={refresh}
      />
    </div>
  );
}
