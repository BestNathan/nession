import { useEffect, useRef } from 'react';
import {
  editorTargetKey,
  EnvironmentGuardDialog,
  EnvironmentNavigator,
  EnvImportDialog,
  EnvProfileDetail,
  EnvProfileEditor,
  refKey,
  useEnvironmentWorkspace,
  type EditorTarget,
} from '@/capabilities/env';
import type { WorkspaceAppViewProps } from '@/app/workspace/workspaceContext';

/** The pushed depth's own name, for the shell's navigation bar. */
function pushedTitle(editor: EditorTarget | null, selectedName: string | null): string | null {
  if (editor?.kind === 'new') {
    return 'New environment';
  }
  if (editor?.kind === 'duplicate') {
    return 'Duplicate';
  }
  return selectedName;
}

/**
 * App layout (#1202): the navigator at the capability root and the Profile
 * Detail / Edit depth pushed over it through the shell's depth control
 * (#1051) — one Back, owned by the shell; the dirty guard, owned by the
 * capability's `leaveDepth`. No `AppToolScroll`, no internal back bar: the
 * pushed surface fills the pane and the dock hides for it. The list's scroll
 * position is snapshotted so popping the detail lands where the user left.
 */
export function EnvAppLayout({ ctx, depth }: WorkspaceAppViewProps) {
  const env = useEnvironmentWorkspace(ctx.session?.session_id ?? null);
  const { profiles, screen, selectedProfile } = env;
  const listScrollTop = useRef(0);

  const title = pushedTitle(screen.editor, selectedProfile?.name ?? null);
  const setPush = depth.setPush;
  const leaveDepth = screen.leaveDepth;
  useEffect(() => {
    setPush(title === null ? null : { title, onLeave: leaveDepth });
  }, [setPush, title, leaveDepth]);

  const dialogs = (
    <>
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
    </>
  );

  if (screen.editor) {
    return (
      <div data-testid="env-workspace-app" className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-hidden">
          <EnvProfileEditor
            key={editorTargetKey(screen.editor, screen.selectedKey)}
            target={screen.editor}
            profile={selectedProfile}
            agents={ctx.agents}
            onDirtyChange={screen.setDirty}
            onCancel={screen.cancelEdit}
            onSave={env.save}
          />
        </div>
        {dialogs}
      </div>
    );
  }

  if (selectedProfile) {
    return (
      <div data-testid="env-workspace-app" className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-hidden">
          <EnvProfileDetail
            profile={selectedProfile}
            agents={ctx.agents}
            active={profiles.activeKeys.has(refKey(selectedProfile))}
            hasSession={profiles.sessionId !== null}
            sessionActionPending={profiles.sessionActionPending}
            onApply={() => void profiles.applyToSession(selectedProfile)}
            onRemove={() => void profiles.removeFromSession(selectedProfile)}
            onEdit={screen.startEdit}
            onDuplicate={() => screen.startDuplicate(selectedProfile)}
            onDelete={() => env.deleteProfile(selectedProfile)}
          />
        </div>
        {dialogs}
      </div>
    );
  }

  return (
    <div data-testid="env-workspace-app" className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
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
          restoredScrollTop={listScrollTop.current}
          onScrollSnapshot={(top) => {
            listScrollTop.current = top;
          }}
        />
      </div>
      {dialogs}
    </div>
  );
}
