import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/shared/lib/utils';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';

export const SANDBOX_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'filesystem', label: 'Filesystem' },
  { id: 'network', label: 'Network' },
  { id: 'process', label: 'Process' },
  { id: 'resource', label: 'Resource' },
  { id: 'syscall', label: 'Syscall' },
] as const;

export type SandboxTabId = (typeof SANDBOX_TABS)[number]['id'];

export interface SandboxPolicyTabsProps {
  experience: 'web' | 'app';
  value: SandboxTabId;
  onValueChange: (value: SandboxTabId) => void;
  /** The selected tab's panel. Inactive panels are not rendered. */
  renderPanel: (tab: SandboxTabId) => ReactNode;
}

/**
 * The six peer policy tabs (#3143).
 *
 * The tabs are local navigation: they never push route/history depth and only
 * change which domain surface is visible. The draft and the authenticated
 * context live above this component, so switching preserves both. Web uses a
 * vertical left list beside one independently scrolling panel; App uses a
 * horizontal, touch-sized strip above the App's existing vertical scroller.
 */
export function SandboxPolicyTabs({
  experience,
  value,
  onValueChange,
  renderPanel,
}: SandboxPolicyTabsProps) {
  const vertical = experience === 'web';
  return (
    <Tabs
      value={value}
      onValueChange={(next) => onValueChange(next as SandboxTabId)}
      orientation={vertical ? 'vertical' : 'horizontal'}
      className={cn(
        'flex min-w-0',
        vertical ? 'min-h-0 flex-1 gap-4' : 'flex-col gap-0',
      )}
    >
      <div
        className={cn(
          vertical
            ? 'w-40 shrink-0'
            : 'sticky top-0 z-10 -mx-3 bg-background px-3 pb-1',
        )}
      >
        {/* App's horizontal strip is a touch surface: its triggers are 44px, so
            the list must take its content height. The primitive's
            `group-data-horizontal/tabs:h-8` is what would otherwise clip the
            strip vertically (measured 52px scrollHeight in a 32px box), and a
            data-variant selector has higher specificity than `h-auto`; the
            important utility is the composition's explicit override, not a
            new primitive default. Vertical (Web) lists keep the primitive
            height. */}
        <TabsList
          variant="line"
          activateOnFocus
          aria-label="Sandbox policy sections"
          data-testid="sandbox-tabs"
          data-orientation={vertical ? 'vertical' : 'horizontal'}
          className={cn(
            vertical
              ? 'flex h-auto w-full flex-col items-stretch gap-0.5'
              : 'flex h-auto! w-full flex-nowrap items-stretch justify-start gap-1 overflow-x-auto',
          )}
        >
          {SANDBOX_TABS.map((tab) => (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              data-testid={`sandbox-tab-${tab.id}`}
              className={cn(
                'flex-none',
                vertical
                  ? 'h-10 w-full justify-start px-2 text-left'
                  : 'h-11 px-3',
              )}
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <div
        data-testid="sandbox-tab-content"
        className={
          vertical
            ? cn('min-h-0 min-w-0 flex-1 overflow-y-auto', workspaceScrollClearanceClass)
            : 'min-w-0'
        }
      >
        {SANDBOX_TABS.map((tab) => (
          <TabsContent
            key={tab.id}
            value={tab.id}
            data-testid={`sandbox-tabpanel-${tab.id}`}
            className="min-w-0 outline-none"
          >
            {value === tab.id ? renderPanel(tab.id) : null}
          </TabsContent>
        ))}
      </div>
    </Tabs>
  );
}
