import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { Agent, EnvFileInfo, EnvSource, EnvWriteResponse } from '@/types';
import { CodeMirrorEditor } from '@/platform/editor';
import { parseEnv } from '@/capabilities/env/model/envParser';
import { profileSourceLine } from '@/capabilities/env/model/profile';
import { toRef } from '@/capabilities/env/model/envRef';
import { useEnvProfileContent } from '@/capabilities/env/hooks/useEnvProfileContent';
import {
  useEnvEditorDraft,
  type EnvEditorDraft,
} from '@/capabilities/env/hooks/useEnvEditorDraft';
import {
  useEnvProfileSave,
  type EnvProfileSaveFlow,
  type EnvProfileSaveInput,
} from '@/capabilities/env/hooks/useEnvProfileSave';
import type { EditorTarget } from '@/capabilities/env/hooks/useEnvironmentScreen';
import { EnvDiff } from '@/capabilities/env/components/EnvDiff';

export type { EnvProfileSaveInput };

interface EnvProfileEditorProps {
  target: EditorTarget;
  /** The selected profile, for `kind: 'existing'`. */
  profile: EnvFileInfo | null;
  agents: Agent[];
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  /** One write attempt; on success the parent navigates away from Edit. */
  onSave: (input: EnvProfileSaveInput) => Promise<EnvWriteResponse>;
}

function editorTitle(target: EditorTarget): string {
  if (target.kind === 'new') {
    return 'New environment';
  }
  if (target.kind === 'duplicate') {
    return `Duplicate of ${target.source.name}`;
  }
  return 'Edit environment';
}

function IdentityFields({
  draft,
  agents,
  disabled,
}: {
  draft: EnvEditorDraft;
  agents: Agent[];
  disabled: boolean;
}) {
  const onlineAgents = agents.filter((a) => a.status === 'online');
  return (
    <div className="flex flex-wrap items-end gap-3 px-4 pt-3">
      <div className="flex min-w-40 flex-[2] flex-col gap-1.5">
        <Label className="text-xs">Name</Label>
        <Input
          data-testid="env-editor-name"
          value={draft.name}
          onChange={(e) => draft.setName(e.target.value)}
          placeholder="staging.env"
          disabled={disabled}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-1 flex-col gap-1.5">
        <Label className="text-xs">Location</Label>
        <Select
          value={draft.source}
          onValueChange={(v) => v && draft.setSource(v as EnvSource)}
          disabled={disabled}
        >
          <SelectTrigger data-testid="env-editor-location">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="server">Server</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {draft.source === 'agent' ? (
        <div className="flex flex-1 flex-col gap-1.5">
          <Label className="text-xs">Agent</Label>
          <Select
            value={draft.agentId}
            onValueChange={(v) => v && draft.setAgentId(v)}
            disabled={disabled || onlineAgents.length === 0}
          >
            <SelectTrigger data-testid="env-editor-agent">
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
    </div>
  );
}

function EditorBody({
  draft,
  target,
  profile,
  agents,
  saving,
  loading,
  loadError,
  onRetry,
}: {
  draft: EnvEditorDraft;
  target: EditorTarget;
  profile: EnvFileInfo | null;
  agents: Agent[];
  saving: boolean;
  loading: boolean;
  loadError: string | null;
  onRetry: () => void;
}) {
  if (loading && !draft.initialized) {
    return (
      <div className="flex flex-1 flex-col gap-1 p-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  if (loadError && !draft.initialized) {
    return (
      <div className="flex flex-1 flex-col items-center gap-2 px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground">{loadError}</p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  const warnings = parseEnv(draft.content).warnings;
  const hasDiff = target.kind === 'existing' && draft.content !== draft.originalContent;
  return (
    <>
      {draft.isNew ? <IdentityFields draft={draft} agents={agents} disabled={saving} /> : null}
      <div className="min-h-0 flex-1 p-2" data-testid="env-editor-surface">
        <CodeMirrorEditor
          value={draft.content}
          onChange={draft.setContent}
          language="env"
          filename={draft.isNew ? draft.name : (profile?.name ?? '')}
        />
      </div>
      {warnings.length > 0 ? (
        <div className="border-t px-4 py-2" data-testid="env-editor-warnings">
          <p className="text-xs font-medium text-warning">
            {warnings.length === 1
              ? '1 line will be skipped'
              : `${warnings.length} lines will be skipped`}
          </p>
          {warnings.map((w, i) => (
            <p key={i} className="mt-0.5 font-mono text-xs text-muted-foreground">
              {w}
            </p>
          ))}
        </div>
      ) : null}
      {hasDiff ? (
        <details className="border-t px-4 py-2" data-testid="env-editor-review">
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
            Review changes
          </summary>
          <div className="mt-2">
            <EnvDiff original={draft.originalContent} modified={draft.content} />
          </div>
        </details>
      ) : null}
    </>
  );
}

function SaveDialogs({
  flow,
  inUseBy,
  name,
}: {
  flow: EnvProfileSaveFlow;
  inUseBy: string[];
  name: string;
}) {
  return (
    <>
      <AlertDialog open={flow.impactOpen} onOpenChange={flow.setImpactOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save and update running sessions?</AlertDialogTitle>
            <AlertDialogDescription>
              This profile is used by{' '}
              {inUseBy.length === 1
                ? '1 running session'
                : `${inUseBy.length} running sessions`}
              {inUseBy.length > 0 ? ` (${inUseBy.join(', ')})` : ''}. Saving may re-source
              those sessions, which can interrupt work relying on the current values.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={flow.saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="env-save-impact-confirm"
              onClick={flow.confirmImpact}
              disabled={flow.saving}
            >
              Save and update
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={flow.overwriteOpen} onOpenChange={flow.setOverwriteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace existing profile?</AlertDialogTitle>
            <AlertDialogDescription>
              A profile named {name} already exists at this location. Saving replaces its
              contents.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={flow.saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="env-save-overwrite-confirm"
              onClick={flow.confirmOverwrite}
              disabled={flow.saving}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The explicit Edit depth (#1202 §4): the canonical code surface for raw
 * source, identity metadata read-only for an existing profile, Review changes
 * only while dirty, Save/Cancel dominant, and an in-use save that names the
 * Session impact instead of saying "Force".
 */
export function EnvProfileEditor({
  target,
  profile,
  agents,
  onDirtyChange,
  onCancel,
  onSave,
}: EnvProfileEditorProps) {
  const loadRef =
    target.kind === 'existing' && profile
      ? toRef(profile)
      : target.kind === 'duplicate'
        ? toRef(target.source)
        : null;
  const { content: loaded, inUseBy, loading, error: loadError, reload } =
    useEnvProfileContent(loadRef);
  const draft = useEnvEditorDraft(target, profile, agents, loaded);
  const flow = useEnvProfileSave({
    isNew: draft.isNew,
    inUseBy,
    buildInput: (overwrite, force) => ({
      ref: draft.buildRef(),
      content: draft.content,
      overwrite,
      force,
    }),
    onSave,
  });

  useEffect(() => {
    onDirtyChange(draft.dirty);
  }, [draft.dirty, onDirtyChange]);

  const canSave =
    !flow.saving &&
    (!draft.isNew || (draft.nameValid && draft.locationValid)) &&
    (draft.isNew || draft.dirty);

  return (
    <div data-testid="env-profile-editor" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h2 className="truncate text-sm font-semibold">{editorTitle(target)}</h2>
        {target.kind === 'existing' && profile ? (
          <span className="truncate text-xs text-muted-foreground">
            {profile.name} · {profileSourceLine(profile, agents)}
          </span>
        ) : null}
        {draft.dirty ? (
          <span data-testid="env-editor-dirty" className="shrink-0 text-xs text-muted-foreground">
            Unsaved changes
          </span>
        ) : null}
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          data-testid="env-editor-cancel"
          onClick={onCancel}
          disabled={flow.saving}
        >
          Cancel
        </Button>
        <Button size="sm" data-testid="env-editor-save" onClick={flow.save} disabled={!canSave}>
          {flow.saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <EditorBody
        draft={draft}
        target={target}
        profile={profile}
        agents={agents}
        saving={flow.saving}
        loading={loading}
        loadError={loadError}
        onRetry={() => void reload()}
      />
      {flow.error ? (
        <p className="border-t px-4 py-2 text-sm text-destructive">{flow.error}</p>
      ) : null}
      {!draft.nameValid && draft.isNew ? (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          Name the environment to save it.
        </p>
      ) : null}

      <SaveDialogs flow={flow} inUseBy={inUseBy} name={draft.buildRef().name} />
    </div>
  );
}
