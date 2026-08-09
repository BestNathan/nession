import { useRef, useState, type ChangeEvent, type DragEvent, type RefObject } from 'react';
import { Upload, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import type { Agent, EnvSource } from '../../types';

interface EnvUploadDialogProps {
  isOpen: boolean;
  onClose: () => void;
  agents: Agent[];
  onUpload: (file: File, source: EnvSource, agentId?: string) => Promise<void>;
}

export function EnvUploadDialog({ isOpen, onClose, agents, onUpload }: EnvUploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<EnvSource>('server');
  const [agentId, setAgentId] = useState('');
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const onlineAgents = agents.filter((a) => a.status === 'online');

  const reset = () => {
    setFile(null);
    setSource('server');
    setAgentId('');
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    if (!file || uploading) {
      return;
    }
    setUploading(true);
    try {
      await onUpload(file, source, source === 'agent' ? agentId : undefined);
      close();
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Env File</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <FileDropZone
            file={file}
            inputRef={inputRef}
            onSelect={setFile}
            disabled={uploading}
          />
          <div className="flex flex-col gap-2">
            <Label>Source</Label>
            <Select
              value={source}
              onValueChange={(v) => v && setSource(v as EnvSource)}
              disabled={uploading}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="server">Server</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {source === 'agent' && (
            <div className="flex flex-col gap-2">
              <Label>Agent</Label>
              <Select
                value={agentId}
                onValueChange={(v) => v && setAgentId(v)}
                disabled={uploading || onlineAgents.length === 0}
              >
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={onlineAgents.length === 0 ? 'No online agents' : 'Select an agent'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {onlineAgents.map((a) => (
                    <SelectItem key={a.agent_id} value={a.agent_id}>
                      {a.hostname} ({a.agent_id})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={uploading}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!file || uploading || (source === 'agent' && !agentId)}
          >
            {uploading ? 'Uploading…' : 'Upload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Dashed drop zone that opens the file picker on click. */
function FileDropZone({
  file,
  inputRef,
  onSelect,
  disabled,
}: {
  file: File | null;
  inputRef: RefObject<HTMLInputElement>;
  onSelect: (file: File | null) => void;
  disabled: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    onSelect(e.dataTransfer.files?.[0] ?? null);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onSelect(e.target.files?.[0] ?? null);
    e.target.value = '';
  };

  return (
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-4 py-8 text-center transition-colors',
          dragOver ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        {file ? (
          <>
            <FileText className="w-5 h-5 text-muted-foreground" />
            <span className="text-sm font-medium truncate max-w-full">{file.name}</span>
            <span className="text-xs text-muted-foreground">
              {(file.size / 1024).toFixed(1)} KB
            </span>
          </>
        ) : (
          <>
            <Upload className="w-5 h-5 text-muted-foreground" />
            <span className="text-sm font-medium">Click to select or drag & drop</span>
            <span className="text-xs text-muted-foreground">.env or text files</span>
          </>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".env,text/plain"
        className="hidden"
        disabled={disabled}
        onChange={handleChange}
      />
    </div>
  );
}
