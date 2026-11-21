import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { shellIconButtonClass } from '@/app/shellStyles';
import { cn } from '@/shared/lib/utils';
import type {
  WorkspaceActionIcon,
  WorkspaceHeaderAction,
} from '@/app/workspace/workspaceContext';
import { APP_ACTION_ICONS, partitionHeaderActions } from './appActionIcons';

/**
 * The App's icon-first action geometry (#3971).
 *
 * A row, toolbar or header action is a 44px touch target on App regardless of
 * the glyph it paints. The `shellIconButtonClass` is the same box Back uses, so
 * an action can never be smaller than the navigation affordance beside it.
 */
export function AppIconButton({
  icon,
  label,
  testId,
  onActivate,
  className,
  disabled,
}: {
  icon: WorkspaceActionIcon;
  label: string;
  testId?: string;
  onActivate: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const Glyph = APP_ACTION_ICONS[icon];
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(shellIconButtonClass, className)}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onActivate()}
    >
      <Glyph className="size-5" aria-hidden />
    </Button>
  );
}

/**
 * The header's action cluster: compact semantic icons, then More.
 *
 * The shell owns this geometry and the glyphs; a capability contributes only
 * `WorkspaceHeaderAction` semantics. Missing actions leave no inert
 * placeholder — no priority actions means no icon slot, no overflow means no
 * More.
 */
export function AppHeaderActions({
  actions,
}: {
  actions: readonly WorkspaceHeaderAction[];
}) {
  const { priority, overflow } = partitionHeaderActions(actions);
  if (priority.length === 0 && overflow.length === 0) {
    return null;
  }
  return (
    <div className="flex shrink-0 items-center gap-1" data-testid="app-page-actions">
      {priority.map((action) => (
        <AppIconButton
          key={action.id}
          icon={action.icon}
          label={action.ariaLabel ?? action.label}
          testId={`app-page-action-${action.id}`}
          onActivate={action.onActivate}
        />
      ))}
      {overflow.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={shellIconButtonClass}
                aria-label="More actions"
                data-testid="app-page-more"
              >
                <MoreHorizontal className="size-5" aria-hidden />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-56">
            {overflow.map((action) => {
              const Glyph = APP_ACTION_ICONS[action.icon];
              return (
                <DropdownMenuItem
                  key={action.id}
                  data-testid={`app-page-action-${action.id}`}
                  variant={action.destructive === true ? 'destructive' : 'default'}
                  onClick={() => action.onActivate()}
                >
                  <Glyph className="size-4" aria-hidden />
                  {action.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
