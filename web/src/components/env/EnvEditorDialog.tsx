import { useRef, useEffect } from 'react';
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
import type { WebSocketService } from '../../services/websocket';
import { useEnvEditor } from './useEnvEditor';

interface EnvEditorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  wsService: WebSocketService;
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
  wsService,
  editing,
  agents,
  onSaved,
}: EnvEditorDialogProps) {
  const editor = useEnvEditor({ wsService, isOpen, editing, agents, onSaved, onClose });
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
          <div className="space-y-2">
            <Label htmlFor="env-content">Content</Label>
            <Textarea
              id="env-content"
              value={editor.content}
              onChange={(e) => editor.setContent(e.target.value)}
              placeholder={PLACEHOLDER}
              disabled={editor.loading}
              className="font-mono text-xs h-64"
              spellCheck={false}
            />
          </div>
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
