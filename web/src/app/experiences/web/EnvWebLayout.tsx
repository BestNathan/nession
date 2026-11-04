import {
  BindingDraftView,
  editorTargetKey,
  EnvironmentGuardDialog,
  EnvironmentNavigator,
  EnvImportDialog,
  EnvProfileDetail,
  EnvProfileEditor,
  refKey,
  SessionEnvironmentView,
  bindingStatus,
  useEnvironmentWorkspace,
} from '@/capabilities/env';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

/**
 * Web layout (#1202, Session-first in #2654): a bounded Profile navigator and
 * a flexible main surface. With a Session, the main surface opens on the
 * Session Environment overview; the read-first Profile Detail and the ordered
 * binding draft replace it without adding a third pane.
 */
export function EnvWebLayout({ ctx }: { ctx: WorkspaceContext }) {
  const env = useEnvironmentWorkspace(ctx.session?.session_id ?? null);
  const { profiles, screen, selectedProfile, binding } = env;
  const sessionId = ctx.session?.session_id ?? null;
  const sessionName = ctx.session?.session_name ?? null;
  const status = bindingStatus(binding.binding, binding.error);

  const main = () => {
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
    if (screen.view === 'draft' && screen.draft) {
      return (
        <BindingDraftView
          baseline={screen.draftBaseline ?? []}
          draft={screen.draft}
          profiles={profiles.profiles}
          agents={ctx.agents}
          dirty={screen.dirty}
          pending={binding.pending}
          error={binding.error}
          onChange={screen.setDraftRefs}
          onCancel={screen.cancelBindingDraft}
          onApply={env.applyBinding}
        />
      );
    }
    if (selectedProfile) {
      return (
        <EnvProfileDetail
          profile={selectedProfile}
          agents={ctx.agents}
          includedInBinding={env.includedKeys.has(refKey(selectedProfile))}
          sessionLabel={sessionId ? status.title : null}
          onShowSession={env.showSession}
          onEdit={screen.startEdit}
          onDuplicate={() => screen.startDuplicate(selectedProfile)}
          onDelete={() => env.deleteProfile(selectedProfile)}
        />
      );
    }
    if (sessionId) {
      return (
        <SessionEnvironmentView
          sessionId={sessionId}
          sessionName={sessionName}
          binding={binding}
          profiles={profiles.profiles}
          agents={ctx.agents}
          pending={binding.pending}
          onManage={env.startBindingDraft}
          onReapply={env.reapplyBinding}
          onRetry={() => void binding.refresh()}
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
        className="grid h-full min-h-0 grid-cols-[var(--nession-workspace-tree-width)_minmax(0,1fr)] overflow-hidden"
      >
        <div className="bg-workspace-navigation min-h-0 overflow-hidden">
          <EnvironmentNavigator
            profiles={profiles.profiles}
            agents={ctx.agents}
            includedKeys={env.includedKeys}
            loading={profiles.loading}
            error={profiles.error}
            selectedKey={screen.selectedKey}
            onSelect={screen.selectProfile}
            onNew={screen.startNew}
            onImport={env.openImport}
            onRetry={() => void profiles.refresh()}
          />
        </div>
        <div className="min-h-0 overflow-hidden">{main()}</div>
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
