import { useMemo, useState } from 'react';
import { MoreHorizontal, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import type { Agent, EnvFileInfo } from '@/types';
import { CodeMirrorEditor } from '@/platform/editor';
import { parseEnv } from '@/capabilities/env/model/envParser';
import { profileSourceLine, variablesLabel } from '@/capabilities/env/model/profile';
import { useEnvProfileContent } from '@/capabilities/env/hooks/useEnvProfileContent';
import { toRef } from '@/capabilities/env/model/envRef';
import { EnvVariablesView } from '@/capabilities/env/components/EnvVariablesView';

export interface EnvProfileDetailProps {
  profile: EnvFileInfo;
  agents: Agent[];
  /** Sourced into the current Session. */
  active: boolean;
  /** Apply/Remove exist only against a current Session. */
  hasSession: boolean;
  sessionActionPending: boolean;
  onApply: () => void;
  onRemove: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  /** Performs the delete; the detail owns the confirmation dialog. */
  onDelete: () => Promise<void>;
}

function UsageLine({ inUseBy, active }: { inUseBy: string[]; active: boolean }) {
  if (inUseBy.length === 0) {
    return null;
  }
  return (
    <p data-testid="env-profile-usage" className="text-xs text-muted-foreground">
      Used by {inUseBy.length === 1 ? '1 session' : `${inUseBy.length} sessions`}
      {' · '}
      {inUseBy.join(', ')}
      {active ? ' — including this Session' : ''}
    </p>
  );
}

function SessionAction({
  active,
  pending,
  onApply,
  onRemove,
}: {
  active: boolean;
  pending: boolean;
  onApply: () => void;
  onRemove: () => void;
}) {
  if (active) {
    return (
      <Button
        size="sm"
        variant="outline"
        data-testid="env-remove-from-session"
        disabled={pending}
        onClick={onRemove}
      >
        Remove from Session
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid="env-apply-to-session"
      disabled={pending}
      onClick={onApply}
    >
      Apply to Session
    </Button>
  );
}

function DetailHeader({
  profile,
  agents,
  active,
  hasSession,
  sessionActionPending,
  inUseBy,
  onApply,
  onRemove,
  onEdit,
  onDuplicate,
  onDeleteRequest,
}: Omit<EnvProfileDetailProps, 'onDelete'> & {
  inUseBy: string[];
  onDeleteRequest: () => void;
}) {
  return (
    <div className="flex items-start gap-2 border-b px-4 py-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold">{profile.name}</h2>
          {active ? (
            <span
              data-testid="env-profile-active"
              className="shrink-0 text-xs text-muted-foreground"
            >
              Active in current Session
            </span>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {profileSourceLine(profile, agents)} · {variablesLabel(profile.var_count)}
        </p>
        <UsageLine inUseBy={inUseBy} active={active} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {hasSession ? (
          <SessionAction
            active={active}
            pending={sessionActionPending}
            onApply={onApply}
            onRemove={onRemove}
          />
        ) : null}
        <Button size="sm" variant="outline" data-testid="env-edit" onClick={onEdit}>
          <Pencil className="size-3.5" />
          Edit
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="More actions"
                data-testid="env-more"
              />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem data-testid="env-duplicate" onClick={onDuplicate}>
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="env-delete"
              variant="destructive"
              onClick={onDeleteRequest}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function DeleteDialog({
  profile,
  agents,
  inUseBy,
  open,
  onOpenChange,
  onDelete,
}: {
  profile: EnvFileInfo;
  agents: Agent[];
  inUseBy: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const confirm = async () => {
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
      onOpenChange(false);
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {profile.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the environment profile at {profileSourceLine(profile, agents)}.
            {inUseBy.length > 0
              ? ` It is currently used by ${inUseBy.length === 1 ? '1 session' : `${inUseBy.length} sessions`} (${inUseBy.join(', ')}).`
              : ''}{' '}
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="env-delete-confirm"
            onClick={() => void confirm()}
            disabled={deleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DetailBody({
  profile,
  content,
  loading,
  error,
  onRetry,
}: {
  profile: EnvFileInfo;
  content: string | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const parsed = useMemo(() => parseEnv(content ?? ''), [content]);
  if (loading && content === null) {
    return (
      <div className="flex flex-col gap-1 p-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <Tabs defaultValue="variables" className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="border-b px-4 pt-2">
        <TabsList variant="line">
          <TabsTrigger value="variables">Variables</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="variables" className="flex min-h-0 flex-1 flex-col">
        <EnvVariablesView vars={parsed.vars} warnings={parsed.warnings} />
      </TabsContent>
      <TabsContent value="raw" className="min-h-0 flex-1">
        <div className="h-full" data-testid="env-raw-view">
          <CodeMirrorEditor
            value={content ?? ''}
            onChange={() => undefined}
            readOnly
            language="env"
            filename={profile.name}
          />
        </div>
      </TabsContent>
    </Tabs>
  );
}

/**
 * The read-first Profile Detail (#1202): parsed Variables are the primary
 * content, Raw stays one tab away, and Edit/Duplicate/Delete disclose from
 * the header rather than living permanently in the surface.
 */
export function EnvProfileDetail(props: EnvProfileDetailProps) {
  const { profile, onDelete } = props;
  const { content, inUseBy, loading, error, reload } = useEnvProfileContent(toRef(profile));
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div data-testid="env-profile-detail" className="flex h-full min-h-0 flex-col">
      <DetailHeader
        {...props}
        inUseBy={inUseBy}
        onDeleteRequest={() => setDeleteOpen(true)}
      />
      <DetailBody
        profile={profile}
        content={content}
        loading={loading}
        error={error}
        onRetry={() => void reload()}
      />
      <DeleteDialog
        profile={profile}
        agents={props.agents}
        inUseBy={inUseBy}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDelete={onDelete}
      />
    </div>
  );
}
