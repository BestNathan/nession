import { Keyboard, TerminalIcon, Package, FolderTree, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

export type BottomTab = 'input' | 'commands' | 'env' | 'files';

interface BottomBarProps {
  activeTab: BottomTab;
  onTabChange: (tab: BottomTab) => void;
  envPanel: React.ReactNode;
  commandsPanel: React.ReactNode;
  inputPanel?: React.ReactNode;
  /** Mobile-only Files tab content (FileBrowser). Rendered only when showFilesTab. */
  filesPanel?: React.ReactNode;
  /** Whether to show the Files tab (mobile only). */
  showFilesTab?: boolean;
  sheetOpen: boolean;
  onSheetToggle: (open: boolean) => void;
}

/** Bottom bar: tabbed Input / Commands / Env / (mobile) Files. */
export function BottomBar({
  activeTab,
  onTabChange,
  envPanel,
  commandsPanel,
  inputPanel,
  filesPanel,
  showFilesTab = false,
  sheetOpen,
  onSheetToggle,
}: BottomBarProps) {
  // Mobile: tapping a tab both selects it and opens the sheet.
  const selectTab = (tab: BottomTab) => {
    onTabChange(tab);
    onSheetToggle(true);
  };

  // Stale fallback
  const effectiveTab = activeTab === 'files' && !showFilesTab ? 'commands' : activeTab;

  const maxH = 'max-h-[85dvh] sm:h-[30vh]';

  const tabs: Array<{
    id: BottomTab;
    icon: typeof TerminalIcon;
    label: string;
    show: boolean;
  }> = [
    { id: 'input', icon: Keyboard, label: 'Input', show: !!inputPanel },
    { id: 'commands', icon: TerminalIcon, label: 'Commands', show: true },
    { id: 'env', icon: Package, label: 'Env', show: true },
    { id: 'files', icon: FolderTree, label: 'Files', show: showFilesTab },
  ];

  return (
    <Tabs
      value={effectiveTab}
      onValueChange={(v) => selectTab(v as BottomTab)}
      className={cn('flex-shrink-0 flex flex-col gap-0 border-t border-border/50 pb-[env(safe-area-inset-bottom)]', maxH)}
    >
      <div className="flex items-center gap-2 px-2 pt-1">
        <TabsList className="text-xs">
          {tabs.map(({ id, icon, label, show }) => {
            if (!show) {
              return null;
            }
            const Icon = icon;
            return (
              <TabsTrigger key={id} value={id} className="gap-1 text-xs">
                <Icon className="h-3 w-3" /> {label}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {/* Mobile-only sheet toggle */}
        <button
          type="button"
          onClick={() => onSheetToggle(!sheetOpen)}
          className="ml-auto p-1 text-muted-foreground hover:text-foreground sm:hidden"
          title={sheetOpen ? 'Collapse' : 'Expand'}
        >
          {sheetOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* Content: always shown at sm+; on mobile only when the sheet is open */}
      <div
        className={cn(
          'flex-1 min-h-0 overflow-y-auto',
          sheetOpen ? 'block' : 'hidden sm:block',
        )}
      >
        <TabsContent value="input" className="mt-0 h-full">{inputPanel}</TabsContent>
        <TabsContent value="commands" className="mt-0 h-full">{commandsPanel}</TabsContent>
        <TabsContent value="env" className="mt-0 h-full">{envPanel}</TabsContent>
        {showFilesTab && <TabsContent value="files" className="mt-0 h-full">{filesPanel}</TabsContent>}
      </div>
    </Tabs>
  );
}
