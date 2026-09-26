import { cn } from '@/shared/lib/utils';
import { titleAppClass } from '@/app/experiences/app/appTypography';
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
      className="flex shrink-0 items-center gap-1 px-[var(--shell-space-2)] pt-[max(var(--shell-space-1),env(safe-area-inset-top))]"
    >
      <AppBackButton label="Back to terminal" testid="app-tool-back" onClick={onBack} />
      {/* The tool's name is the page's title — `visual-language.md`'s role
          vocabulary names "current capability title", and the typography
          criterion puts page titles in the product face. It was monospaced,
          which read a capability's name as if it were a path or an identifier
          (#1050 stage 4). The path inside the tool is the technical string, and
          `FilesAppLayout` still sets that one in mono — at the *title* size,
          because family and size are independent (#1073 stage: the `text-sm`
          that stood here was a primitive default doing a title's job). */}
      <h1 className={cn('min-w-0 truncate font-semibold', titleAppClass)}>{toolLabel}</h1>
    </header>
  );
}
