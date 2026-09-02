import { AppBackButton } from './AppBackButton';

export interface AppToolHeaderProps {
  toolLabel: string;
  /** Top-level navigation: back to the Terminal page (never internal push). */
  onBack: () => void;
}

/**
 * App Workspace-page header: single row — back to Terminal + current tool
 * name. Tool-internal push/pop (e.g. the file viewer) renders its own
 * sub-header inside the tool layout, so this back is always top-level.
 */
export function AppToolHeader({ toolLabel, onBack }: AppToolHeaderProps) {
  return (
    <header
      data-testid="app-tool-header"
      className="flex shrink-0 items-center gap-1 px-[var(--sf-space-2)] pt-[max(var(--sf-space-1),env(safe-area-inset-top))]"
    >
      <AppBackButton label="Back to terminal" testid="app-tool-back" onClick={onBack} />
      <h1 className="min-w-0 truncate font-mono text-sm font-semibold">{toolLabel}</h1>
    </header>
  );
}
