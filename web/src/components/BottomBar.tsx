import { Keyboard, TerminalIcon, Package, FolderTree, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

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

  const maxH = 'max-h-[85dvh] sm:max-h-[40dvh]';

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
    <div className={cn('border-t flex-shrink-0 flex flex-col pb-[env(safe-area-inset-bottom)]', maxH)}>
      <div className="flex border-b items-center">
        {tabs.map(({ id, icon, label, show }) => {
          if (!show) { return null; }
          const Icon = icon;
          return (
            <button
              key={id}
              type="button"
              onClick={() => selectTab(id)}
              className={cn(
                'flex items-center gap-1 px-3 py-1 text-xs transition-colors border-b-2 -mb-px',
                effectiveTab === id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="w-3 h-3" /> {label}
            </button>
          );
        })}
        {/* Mobile-only sheet toggle: expand when collapsed, collapse when open. */}
        <button
          type="button"
          onClick={() => onSheetToggle(!sheetOpen)}
          className="ml-auto px-3 py-1 text-xs text-muted-foreground hover:text-foreground sm:hidden"
          title={sheetOpen ? 'Collapse' : 'Expand'}
        >
          {sheetOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
      </div>
      {/* Content: always shown at sm+; on mobile only when the sheet is open */}
      <div
        className={cn(
          'flex-1 min-h-0 overflow-y-auto',
          sheetOpen ? 'block' : 'hidden sm:block',
        )}
      >
        {effectiveTab === 'input' ? inputPanel : effectiveTab === 'files' ? filesPanel : effectiveTab === 'env' ? envPanel : commandsPanel}
      </div>
    </div>
  );
}
