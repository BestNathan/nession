import { ServerInfoMenu } from '@/features/server/components/ServerInfoMenu';

export function SessionFirstSidebarFooter() {
  return (
    <div className="flex w-full items-center gap-2">
      <ServerInfoMenu variant="footer" />
    </div>
  );
}
