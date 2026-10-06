import { useRef, useState, type ChangeEvent, type DragEvent, type RefObject } from 'react';
import { FileText, Upload } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Agent, EnvFileRef, EnvSource } from '@/types';
import { envApi } from '@/capabilities/env';

type ImportPhase = 'pick' | 'overwrite' | 'impact';

interface EnvImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  agents: Agent[];
  /** Success: the parent refreshes the list and selects the imported profile. */
  onImported: (ref: EnvFileRef) => void;
}

/** Dashed drop zone that opens the file picker on click. */
function FileDropZone({
  file,
  inputRef,
  onSelect,
  disabled,
}: {
  file: File | null;
  inputRef: RefObject<HTMLInputElement | null>;
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
        data-testid="env-import-dropzone"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-1 rounded-[var(--nession-radius-control)] border-2 border-dashed px-4 py-8 text-center transition-colors',
          dragOver ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        {file ? (
          <>
            <FileText className="w-5 h-5 text-muted-foreground" />
            <span className={cn('max-w-full truncate', chromeSansRole('secondary'))}>{file.name}</span>
            <span className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
              {(file.size / 1024).toFixed(1)} KB
            </span>
          </>
        ) : (
          <>
            <Upload className="w-5 h-5 text-muted-foreground" />
            <span className={chromeSansRole('secondary')}>Click to select or drag & drop</span>
            <span className={cn('text-muted-foreground', chromeSansRole('metadata'))}>.env or text files</span>
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

function LocationFields({
  source,
  agentId,
  agents,
  disabled,
  onSource,
  onAgent,
}: {
  source: EnvSource;
  agentId: string;
  agents: Agent[];
  disabled: boolean;
  onSource: (v: EnvSource) => void;
  onAgent: (v: string) => void;
}) {
  const onlineAgents = agents.filter((a) => a.status === 'online');
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label>Location</Label>
        <Select
          value={source}
          onValueChange={(v) => v && onSource(v as EnvSource)}
          disabled={disabled}
        >
          <SelectTrigger className="w-full" data-testid="env-import-location">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="server">Server</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {source === 'agent' ? (
        <div className="flex flex-col gap-2">
          <Label>Agent</Label>
          <Select
            value={agentId}
            onValueChange={(v) => v && onAgent(v)}
            disabled={disabled || onlineAgents.length === 0}
          >
            <SelectTrigger className="w-full" data-testid="env-import-agent">
              <SelectValue
                placeholder={onlineAgents.length === 0 ? 'No online Agents' : 'Select an agent'}
              />
            </SelectTrigger>
            <SelectContent>
              {onlineAgents.map((a) => (
                <SelectItem key={a.agent_id} value={a.agent_id}>
                  {a.display_name ?? a.hostname}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </>
  );
}

function PhaseBody({
  phase,
  file,
  source,
  agentId,
  agents,
  busy,
  name,
  inUseBy,
  inputRef,
  onFile,
  onSource,
  onAgent,
}: {
  phase: ImportPhase;
  file: File | null;
  source: EnvSource;
  agentId: string;
  agents: Agent[];
  busy: boolean;
  name: string;
  inUseBy: string[];
  inputRef: RefObject<HTMLInputElement | null>;
  onFile: (f: File | null) => void;
  onSource: (v: EnvSource) => void;
  onAgent: (v: string) => void;
}) {
  if (phase === 'overwrite') {
    return (
      <p className={chromeSansRole('body')} data-testid="env-import-overwrite">
        A profile named <span className="font-mono">{name}</span> already exists at this
        location. Importing replaces its contents.
      </p>
    );
  }
  if (phase === 'impact') {
    return (
      <p className={chromeSansRole('body')} data-testid="env-import-impact">
        That profile is used by{' '}
        {inUseBy.length === 1 ? '1 running session' : `${inUseBy.length} running sessions`}
        {inUseBy.length > 0 ? ` (${inUseBy.join(', ')})` : ''}. Importing may re-source those
        sessions.
      </p>
    );
  }
  return (
    <>
      <FileDropZone file={file} inputRef={inputRef} onSelect={onFile} disabled={busy} />
      <LocationFields
        source={source}
        agentId={agentId}
        agents={agents}
        disabled={busy}
        onSource={onSource}
        onAgent={onAgent}
      />
    </>
  );
}

function ImportFooter({
  phase,
  busy,
  canSubmit,
  onBack,
  onCancel,
  onSubmit,
}: {
  phase: ImportPhase;
  busy: boolean;
  canSubmit: boolean;
  onBack: () => void;
  onCancel: () => void;
  onSubmit: (overwrite: boolean, force: boolean) => void;
}) {
  if (phase === 'overwrite') {
    return (
      <>
        <Button type="button" variant="outline" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          type="button"
          data-testid="env-import-overwrite-confirm"
          onClick={() => onSubmit(true, false)}
          disabled={busy}
        >
          {busy ? 'Importing…' : 'Replace'}
        </Button>
      </>
    );
  }
  if (phase === 'impact') {
    return (
      <>
        <Button type="button" variant="outline" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          type="button"
          data-testid="env-import-impact-confirm"
          onClick={() => onSubmit(true, true)}
          disabled={busy}
        >
          {busy ? 'Importing…' : 'Import and update'}
        </Button>
      </>
    );
  }
  return (
    <>
      <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button
        type="button"
        data-testid="env-import-submit"
        onClick={() => onSubmit(false, false)}
        disabled={!canSubmit}
      >
        {busy ? 'Importing…' : 'Import'}
      </Button>
    </>
  );
}

/**
 * Import .env file (#1202): one dialog that owns the whole chain — pick a
 * file, refuse to clobber silently (Replace? state), and name the Session
 * impact when the target is in use — instead of the old `window.confirm`.
 */
export function EnvImportDialog({ isOpen, onClose, agents, onImported }: EnvImportDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<EnvSource>('server');
  const [agentId, setAgentId] = useState('');
  const [phase, setPhase] = useState<ImportPhase>('pick');
  const [inUseBy, setInUseBy] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setFile(null);
    setSource('server');
    setAgentId('');
    setPhase('pick');
    setInUseBy([]);
    setError(null);
    onClose();
  };

  const buildRef = (): EnvFileRef | null => {
    if (!file) {
      return null;
    }
    return {
      name: file.name.endsWith('.env') ? file.name : `${file.name}.env`,
      source,
      agent_id: source === 'agent' ? agentId : undefined,
    };
  };

  const attempt = async (overwrite: boolean, force: boolean) => {
    const ref = buildRef();
    if (!file || !ref || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const resp = await envApi.writeEnvFile(ref, await file.text(), overwrite, force);
      if (resp.success) {
        onImported(ref);
        close();
        return;
      }
      if (resp.exists) {
        setPhase('overwrite');
      } else if ((resp.in_use_by?.length ?? 0) > 0) {
        setInUseBy(resp.in_use_by ?? []);
        setPhase('impact');
      } else {
        setError(resp.error ?? 'Failed to import');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import');
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = file !== null && !busy && (source !== 'agent' || agentId !== '');

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md" data-testid="env-import-dialog">
        <DialogHeader>
          <DialogTitle>Import .env file</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <PhaseBody
            phase={phase}
            file={file}
            source={source}
            agentId={agentId}
            agents={agents}
            busy={busy}
            name={buildRef()?.name ?? ''}
            inUseBy={inUseBy}
            inputRef={inputRef}
            onFile={setFile}
            onSource={setSource}
            onAgent={setAgentId}
          />
          {error ? <p className={cn('text-destructive', chromeSansRole('body'))}>{error}</p> : null}
        </div>
        <DialogFooter>
          <ImportFooter
            phase={phase}
            busy={busy}
            canSubmit={canSubmit}
            onBack={() => setPhase('pick')}
            onCancel={close}
            onSubmit={(overwrite, force) => void attempt(overwrite, force)}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
