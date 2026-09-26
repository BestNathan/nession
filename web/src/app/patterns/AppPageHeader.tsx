import { cn } from '@/shared/lib/utils';
import { titleAppClass } from '@/app/experiences/app/appTypography';
import { AppBackButton } from './AppBackButton';

export interface AppPageHeaderProps {
  /**
   * Accessible name for the Back affordance. It names the depth Back goes to,
   * which is what makes "Back" mean one thing here rather than "wherever I came
   * from last" (#1051).
   */
  backLabel: string;
  onBack: () => void;
  /** The page's own name. */
  title: string;
  /**
   * The title is technical identity — a path, a resource id — rather than
   * product text, so it is set in mono.
   *
   * Family only. The size is the title role either way: `visual-language.md`'s
   * role vocabulary names the pushed detail's title in the same breath as the
   * capability's, and its `code` role records that "mono does not imply
   * smaller" — the family says *what the string is*, the role says *what the
   * string does on the page* (#1073).
   */
  technical?: boolean;
}

/**
 * The App's page header — **one** per depth (#1051).
 *
 * The App used to compose several independent chrome owners, each answering
 * "what page am I on?" and "what does Back mean?" for itself: the Workspace
 * page header, a Files-only push sub-header, and the file viewer's own close
 * bar rendered as three stacked rows over one 390px screen. They were three
 * rows because each was written to own its own level; the level, not the
 * component, is what owns navigation.
 *
 * So this is one component at both Workspace depths. A capability root passes
 * its own name and the depth below it (the Terminal); a pushed detail passes the
 * resource it pushed and its capability's root. What changes between them is
 * the two strings, not the number of bars.
 *
 * The capability's own actions are deliberately not here. `#1051` allows them in
 * the page header *or* in a clearly subordinate toolbar, and the file viewer's
 * actions belong to the editor whose state they act on — Edit/Save are only
 * meaningful while the editor is on screen and dirty. What must not happen is
 * what did: a second bar whose Back and Close were two names for one leave.
 */
export function AppPageHeader({ backLabel, onBack, title, technical }: AppPageHeaderProps) {
  return (
    <header
      data-testid="app-page-header"
      className="flex shrink-0 items-center gap-1 px-[var(--shell-space-2)] pt-[max(var(--shell-space-1),env(safe-area-inset-top))]"
    >
      <AppBackButton label={backLabel} testid="app-page-back" onClick={onBack} />
      {/* The page's name. `visual-language.md`'s role vocabulary names "current
          capability title" and "pushed detail title" as the same role, so both
          depths set it here — a capability's name in the product face, a pushed
          path or resource name in mono at the same size (#1050 stage 4, #1073).
          Web's `text-sm` that once stood here was the primitive's desktop
          default doing a title's job. */}
      <h1
        className={cn('min-w-0 truncate font-semibold', technical && 'font-mono', titleAppClass)}
      >
        {title}
      </h1>
    </header>
  );
}
