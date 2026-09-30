import {
  editorTargetKey,
  EnvironmentGuardDialog,
  EnvironmentNavigator,
  EnvImportDialog,
  EnvProfileDetail,
  EnvProfileEditor,
  refKey,
  useEnvironmentWorkspace,
} from '@/capabilities/env';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

/**
 * Web layout (#1202): navigator ‖ Profile Detail on the same grid the Files
 * view uses — a fixed navigation column carrying `workspace.navigation` and a
 * fluid detail on the canvas, so the background shift is the separator and
 * each pane owns its own scroll.
 */
export function EnvWebLayout({ ctx }: { ctx: WorkspaceContext }) {
  const env = useEnvironmentWorkspace(ctx.session?.session_id ?? null);
  const { profiles, screen, selectedProfile } = env;

  const detail = () => {
    if (screen.editor) {
      return (
        <EnvProfileEditor
          key={editorTargetKey(screen.editor, screen.selectedKey)}
          target={screen.editor}
          profile={selectedProfile}
          agents={ctx.agents}
          onDirtyChange={screen.setDirty}
          onCancel={screen.cancelEdit}
          onSave={env.save}
        />
      );
    }
    if (selectedProfile) {
      return (
        <EnvProfileDetail
          profile={selectedProfile}
          agents={ctx.agents}
          active={profiles.activeKeys.has(refKey(selectedProfile))}
          sourcedAtCreate={profiles.createKeys.has(refKey(selectedProfile))}
          hasSession={profiles.sessionId !== null}
          sessionActionPending={profiles.sessionActionPending}
          onApply={() => void profiles.applyToSession(selectedProfile)}
          onRemove={() => void profiles.removeFromSession(selectedProfile)}
          onEdit={screen.startEdit}
          onDuplicate={() => screen.startDuplicate(selectedProfile)}
          onDelete={() => env.deleteProfile(selectedProfile)}
        />
      );
    }
    return (
      <div
        data-testid="env-detail-empty"
        className={cn('flex h-full items-center justify-center px-6 text-center text-muted-foreground', chromeSansRole('secondary'))}
      >
        Select an environment to inspect its variables.
      </div>
    );
  };

  return (
    <div data-testid="env-workspace" className="h-full min-h-0 overflow-hidden">
      <div
        data-testid="env-web-layout"
        className="grid h-full min-h-0 grid-cols-[var(--workspace-tree-width)_minmax(0,1fr)] overflow-hidden"
      >
        <div className="bg-workspace-navigation min-h-0 overflow-hidden">
          <EnvironmentNavigator
            profiles={profiles.profiles}
            agents={ctx.agents}
            activeKeys={profiles.activeKeys}
            hasSession={profiles.sessionId !== null}
            loading={profiles.loading}
            error={profiles.error}
            selectedKey={screen.selectedKey}
            onSelect={screen.selectProfile}
            onNew={screen.startNew}
            onImport={env.openImport}
            onRetry={() => void profiles.refresh()}
          />
        </div>
        <div className="min-h-0 overflow-hidden">{detail()}</div>
      </div>

      <EnvironmentGuardDialog
        open={screen.guardOpen}
        onConfirm={screen.confirmGuard}
        onCancel={screen.cancelGuard}
      />
      <EnvImportDialog
        isOpen={env.importOpen}
        onClose={env.closeImport}
        agents={ctx.agents}
        onImported={env.onImported}
      />
    </div>
  );
}
