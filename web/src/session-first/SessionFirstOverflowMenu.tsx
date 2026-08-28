import { Ellipsis, FileCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ServerInfoMenu } from '@/components/ServerInfoMenu';
import { setSessionFirst } from '@/lib/sessionFirst';

export function SessionFirstOverflowMenu({
  onOpenEnv,
  onLegacy,
}: {
  onOpenEnv: () => void;
  onLegacy: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="More"
          />
        }
      >
        <span data-testid="session-first-overflow">
          <Ellipsis className="size-4" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem
          data-testid="session-first-env"
          onClick={() => onOpenEnv()}
        >
          <FileCog className="size-4" />
          Environment files
        </DropdownMenuItem>
        <div className="px-2 py-1.5">
          <ServerInfoMenu />
        </div>
        <DropdownMenuItem
          data-testid="use-legacy-dashboard"
          onClick={() => {
            setSessionFirst(false);
            onLegacy();
          }}
        >
          Legacy dashboard
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
