import { useState } from 'react';
import { ChevronDown, Layers } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { metadataAppClass, titleAppClass } from '@/app/experiences/app/appTypography';
import { chromeMonoRole } from '@/shared/typography/chromeRoles';
import type {
  WorkspaceHeaderAction,
  WorkspaceStackAncestor,
} from '@/app/workspace/workspaceContext';
import { AppBackButton } from './AppBackButton';
import { AppHeaderActions } from './AppHeaderActions';
import { AppStackSheet } from './AppStackSheet';

export interface AppPageHeaderProps {
  /**
   * Accessible name for the Back affordance. It names the depth Back goes to,
   * which is what makes "Back" mean one thing here rather than "wherever I came
   * from last" (#1051).
   */
  backLabel: string;
  onBack: () => void;
  /** The page's own name — the header's primary title. */
  title: string;
  /** Optional test hook for the host's title node. */
  titleTestId?: string;
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
  /**
   * The header's secondary line (#3971): real ancestry below the title, or the
   * active Session context at a capability root. Never a fabricated
   * breadcrumb; a capability reports only what its stack actually contains.
   */
  subtitle?: string;
  /**
   * The stack above this depth, nearest ancestor first. Present only when the
   * capability can actually jump to those ancestors; the header renders the
   * secondary line as the Stack Sheet trigger only then.
   */
  ancestors?: readonly WorkspaceStackAncestor[];
  /** Jump to an ancestor, running the same leave guard as Back. */
  onJumpToAncestor?: (id: string) => void;
  /**
   * Capability-contributed action semantics (#3971). The host renders at most
   * two compact icons and moves the rest, and every destructive action, into
   * More with readable text. A capability never renders its own header bar.
   */
  actions?: readonly WorkspaceHeaderAction[] | null;
}

/**
 * The App's page header — **one** per depth (#1051, #3971).
 *
 * The App used to compose several independent chrome owners, each answering
 * "what page am I on?" and "what does Back mean?" for itself: the Workspace
 * page header, a Files-only push sub-header, and the file viewer's own close
 * bar rendered as three stacked rows over one 390px screen. They were three
 * rows because each was written to own its own level; the level, not the
 * component, is what owns navigation.
 *
 * #3971 extends the one bar without adding a second one:
 *
 * ```text
 * Back | [primary title + truthful secondary ancestry] | priority icon(s) | More
 * ```
 *
 * The primary title is the current capability/resource; the secondary line is
 * the immediate ancestor or bounded parent path from the capability's real
 * stack. Tapping it opens the optional Stack Sheet when the capability can
 * navigate there. Right-side actions are capability-contributed *semantics*
 * that the host renders as its own icon vocabulary and overflow.
 */
export function AppPageHeader({
  backLabel,
  onBack,
  title,
  titleTestId,
  technical,
  subtitle,
  ancestors,
  onJumpToAncestor,
  actions,
}: AppPageHeaderProps) {
  const [stackOpen, setStackOpen] = useState(false);
  const stackJump = onJumpToAncestor !== undefined
    && ancestors !== undefined
    && ancestors.length > 0;

  return (
    <header
      data-testid="app-page-header"
      className="flex shrink-0 items-center gap-1 px-[var(--nession-shell-space-2)] pt-[max(var(--nession-shell-space-1),env(safe-area-inset-top))]"
    >
      <AppBackButton label={backLabel} testid="app-page-back" onClick={onBack} />
      <div
        data-testid="app-page-titleblock"
        className="relative flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-[var(--nession-rhythm-text-stack)] py-1"
      >
        {/* The page's name. `visual-language.md`'s role vocabulary names "current
            capability title" and "pushed detail title" as the same role, so both
            depths set it here — a capability's name in the product face, a pushed
            path or resource name in mono at the same size (#1050 stage 4, #1073).
            Web's `text-sm` that once stood here was the primitive's desktop
            default doing a title's job. */}
        <h1
          data-testid={titleTestId}
          className={cn('min-w-0 truncate', technical ? chromeMonoRole('title') : titleAppClass)}
        >
          {title}
        </h1>
        {subtitle ? (
          <span
            data-testid="app-page-subtitle-text"
            className={cn(
              'flex min-w-0 items-center gap-[var(--nession-rhythm-text-stack)] text-muted-foreground',
              metadataAppClass,
            )}
          >
            {stackJump ? <Layers className="size-3 shrink-0" aria-hidden /> : null}
            <span className="truncate">{subtitle}</span>
            {stackJump ? <ChevronDown className="size-3 shrink-0" aria-hidden /> : null}
          </span>
        ) : null}
        {/* The stack trigger is the title block itself, so the touch target meets
            the App floor even though the secondary line is deliberately quiet.
            It reaches the optional Stack Sheet and runs the capability's guarded
            jump — not a second navigation owner. */}
        {stackJump ? (
          <button
            type="button"
            data-testid="app-page-subtitle"
            aria-haspopup="dialog"
            aria-expanded={stackOpen}
            aria-label={`Navigation stack, ${subtitle ?? title}`}
            className="absolute inset-0 rounded-[var(--nession-radius-control)] focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]"
            onClick={() => setStackOpen(true)}
          />
        ) : null}
      </div>
      <AppHeaderActions actions={actions ?? []} />
      {stackJump ? (
        <AppStackSheet
          open={stackOpen}
          onOpenChange={setStackOpen}
          title={title}
          ancestors={ancestors}
          onJumpToAncestor={(id) => onJumpToAncestor?.(id)}
        />
      ) : null}
    </header>
  );
}
