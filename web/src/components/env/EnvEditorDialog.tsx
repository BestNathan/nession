import { useRef, useEffect, forwardRef, useState, useMemo } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import type { Agent, EnvFileInfo, EnvSource } from '../../types';
import { parseEnv } from '@/lib/envParser';
import { useEnvEditor } from './useEnvEditor';
import { EnvDiff } from './EnvDiff';

interface EnvEditorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** When set, edit that file; when null, create a new one. */
  editing: EnvFileInfo | null;
  agents: Agent[];
  onSaved: () => void;
}

const PLACEHOLDER =
  '# KEY=VALUE pairs, one per line\n# Lines starting with # are comments\nAPI_URL=https://api.example.com\nDEBUG=false\n';

export function EnvEditorDialog({
  isOpen,
  onClose,
  editing,
  agents,
  onSaved,
}: EnvEditorDialogProps) {
  const editor = useEnvEditor({ isOpen, editing, agents, onSaved, onClose });
  const nameRef = useRef<HTMLInputElement>(null);
  const onlineAgents = agents.filter((a) => a.status === 'online');

  useEffect(() => {
    if (isOpen && !editor.isEdit) {
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [isOpen, editor.isEdit]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editor.isEdit ? `Edit ${editing?.name}` : 'New Env File'}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            editor.submit();
          }}
          className="space-y-4"
        >
          {!editor.isEdit && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="env-name">File Name</Label>
                <Input
                  ref={nameRef}
                  id="env-name"
                  value={editor.name}
                  onChange={(e) => editor.setName(e.target.value)}
                  placeholder="staging.env"
                  disabled={editor.loading}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="env-source">Location</Label>
                <Select
                  value={editor.source}
                  onValueChange={(v) => v && editor.setSource(v as EnvSource)}
                  disabled={editor.loading}
                >
                  <SelectTrigger id="env-source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="server">Server</SelectItem>
                    <SelectItem value="agent">Agent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          {!editor.isEdit && editor.source === 'agent' && (
            <div className="space-y-2">
              <Label htmlFor="env-agent">Agent</Label>
              <Select
                value={editor.agentId}
                onValueChange={(v) => v && editor.setAgentId(v)}
                disabled={editor.loading}
              >
                <SelectTrigger id="env-agent">
                  <SelectValue placeholder="Select an agent" />
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
          <EnvContentEditor
            content={editor.content}
            onContentChange={editor.setContent}
            hideSecrets={editor.hideSecrets}
            onToggleSecrets={() => editor.setHideSecrets(!editor.hideSecrets)}
            loading={editor.loading}
          />
          <ParsePreview content={editor.content} />
          {editor.isEdit && editing && (
            <details className="space-y-1">
              <summary className="cursor-pointer text-xs text-muted-foreground font-medium select-none">
                Preview Changes
              </summary>
              <div className="mt-1.5">
                <EnvDiff original={editor.originalContent} modified={editor.content} />
              </div>
            </details>
          )}
          {editor.error && <p className="text-sm text-destructive">{editor.error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={editor.loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={editor.loading}>
              {editor.loading ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Debounced live parse preview shown below the content editor. */
function ParsePreview({ content }: { content: string }) {
  const [debounced, setDebounced] = useState(content);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    timerRef.current = setTimeout(() => setDebounced(content), 300);
    return () => clearTimeout(timerRef.current);
  }, [content]);

  const parsed = useMemo(() => {
    if (!debounced.trim()) {
      return null;
    }
    return parseEnv(debounced);
  }, [debounced]);

  if (!parsed) {
    return (
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Parsed Variables</Label>
        <p className="text-xs text-muted-foreground">(empty)</p>
      </div>
    );
  }

  const hasWarnings = parsed.warnings.length > 0;

  return (
    <details className="space-y-1" open={hasWarnings}>
      <summary className="cursor-pointer text-xs text-muted-foreground font-medium select-none">
        Parsed Variables ({parsed.vars.length})
        {hasWarnings && (
          <span className="ml-2 text-amber-500">
            {parsed.warnings.length} warning{parsed.warnings.length !== 1 ? 's' : ''}
          </span>
        )}
      </summary>
      <div className="mt-1.5 rounded-md border max-h-40 overflow-y-auto">
        {parsed.warnings.map((w, i) => (
          <p key={`w-${i}`} className="text-[11px] text-amber-600 dark:text-amber-400 px-2 py-0.5 font-mono">
            ⚠️ {w}
          </p>
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
            {parsed.vars.map(([key, value]) => {
              const truncated = value.length > 40 ? value.slice(0, 40) + '…' : value;
              return (
                <tr key={key}>
                  <td className="px-2 py-0.5 font-mono">{key}</td>
                  <td className="px-2 py-0.5 font-mono text-muted-foreground">
                    {truncated || <span className="italic text-muted-foreground">(empty)</span>}
                  </td>
                  <td className="px-2 py-0.5 text-right">{'✅'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

interface EnvContentEditorProps {
  content: string;
  onContentChange: (value: string) => void;
  hideSecrets: boolean;
  onToggleSecrets: () => void;
  loading: boolean;
}

/** Textarea + secret-masking overlay with scroll sync. */
function EnvContentEditor({
  content,
  onContentChange,
  hideSecrets,
  onToggleSecrets,
  loading,
}: EnvContentEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor="env-content">Content</Label>
        <MaskToggleButton hideSecrets={hideSecrets} onToggle={onToggleSecrets} />
      </div>
      <div className="relative">
        <Textarea
          id="env-content"
          ref={textareaRef}
          value={content}
          onChange={(e) => onContentChange(e.target.value)}
          onScroll={() => {
            if (overlayRef.current && textareaRef.current) {
              overlayRef.current.scrollTop = textareaRef.current.scrollTop;
            }
          }}
          placeholder={PLACEHOLDER}
          disabled={loading}
          className="font-mono text-xs h-64"
          spellCheck={false}
        />
        {hideSecrets && <MaskedContentOverlay ref={overlayRef} content={content} />}
      </div>
    </div>
  );
}

/** Toggle button for the "hide secrets" masking mode. */
function MaskToggleButton({
  hideSecrets,
  onToggle,
}: {
  hideSecrets: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={onToggle}
    >
      {hideSecrets ? (
        <><EyeOff className="w-3.5 h-3.5 mr-1" /> Show Secrets</>
      ) : (
        <><Eye className="w-3.5 h-3.5 mr-1" /> Hide Secrets</>
      )}
    </Button>
  );
}

/**
 * Visual overlay that masks secret values. Display-only: the underlying
 * textarea content is never modified. Sits above the textarea with
 * `pointer-events-none` so clicks pass through to the editor below.
 */
const MaskedContentOverlay = forwardRef<HTMLDivElement, { content: string }>(
  function MaskedContentOverlay({ content }, ref) {
    return (
      <div
        ref={ref}
        className="absolute inset-0 font-mono text-xs p-3 pointer-events-none whitespace-pre-wrap break-all overflow-auto bg-background"
        style={{ padding: '0.75rem', lineHeight: '1.5' }}
        aria-hidden="true"
      >
      {content.split('\n').map((line, i) => {
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) {
          return <span key={i}>{line}{'\n'}</span>;
        }
        const key = line.slice(0, eqIdx).trim();
        const isSecret = /(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(key);
        if (isSecret) {
          return (
            <span key={i}>
              {line.slice(0, eqIdx + 1)}
              <span className="text-muted-foreground">********</span>
              {'\n'}
            </span>
          );
        }
        return <span key={i}>{line}{'\n'}</span>;
      })}
      </div>
    );
  },
);
