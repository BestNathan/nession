import { LayoutDashboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ServerInfoMenu } from '@/components/ServerInfoMenu';
import { setSessionFirst } from '@/lib/sessionFirst';
import { shellIconButtonClass, shellMotionClass } from '@/session-first/shellStyles';
import { cn } from '@/lib/utils';

export function SessionFirstSidebarFooter({
  onLegacy,
}: {
  onLegacy: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-2">
      <ServerInfoMenu variant="footer" />
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="use-legacy-dashboard"
        className={cn(shellIconButtonClass, 'min-h-9 flex-1 gap-1.5 px-3', shellMotionClass)}
        onClick={() => {
          setSessionFirst(false);
          onLegacy();
        }}
      >
        <LayoutDashboard className="size-4 shrink-0" />
        <span className="truncate text-xs">Legacy</span>
      </Button>
    </div>
  );
}
