// React-free runtime re-exports — canonical home is core/terminal-runtime.
export { AddonManager } from '@/core/terminal-runtime/AddonManager';
export { Renderer } from '@/core/terminal-runtime/Renderer';
export { ThemeManager, CATPPUCCIN_MOCHA } from '@/core/terminal-runtime/ThemeManager';
export { ConnectionManager } from '@/core/terminal-runtime/ConnectionManager';
export { MouseIntentResolver } from '@/core/terminal-runtime/MouseIntentResolver';
export { FontSizeManager } from '@/core/terminal-runtime/FontSizeManager';
export { PROFILES, detectProfile } from '@/core/terminal-runtime/DeviceProfile';
export type {
  DeviceProfile,
  ConnectionOptions,
  ReconnectBanner,
} from '@/core/terminal-runtime/types';

// New architecture: controller
export { TerminalController, ResizeController } from '@/core/terminal-runtime/controller/TerminalController';

// New architecture: instance
export { TerminalInstance } from '@/core/terminal-runtime/instance/TerminalInstance';
export type { TerminalInstanceOptions } from '@/core/terminal-runtime/types';

// New architecture: input
export { InputRouter } from '@/core/terminal-runtime/input/InputRouter';
export { InputSourceManager } from '@/core/terminal-runtime/input/InputSourceManager';
export { TerminalInputHandler } from '@/core/terminal-runtime/input/TerminalInputHandler';
export type { InputHandler } from '@/core/terminal-runtime/input/InputHandler';
export type { InputSource, InputEvent } from '@/core/terminal-runtime/types';

// New architecture: transport
export type { TerminalTransport } from '@/core/terminal-runtime/transport/TerminalTransport';

// New architecture: state
export {
  terminalSessionAtom,
  terminalSessionStateAtom,
  terminalSizeAtomFamily,
  terminalFocusAtomFamily,
  terminalSelectionAtomFamily,
  terminalTitleAtomFamily,
  inputModeAtomFamily,
  inputValueAtomFamily,
  bannerAtomFamily,
  bannerAttemptAtomFamily,
  capabilitiesAtomFamily,
  terminalViewModelAtomFamily,
  lastResizeAtom,
  sidebarOpenAtom,
  panelSizesAtom,
} from './state';
export type {
  TerminalSession,
  TerminalStatus,
  InputMode,
  TerminalCapabilities,
} from './state';

// New architecture: components
export { TerminalViewport } from './components/TerminalViewport';
export { TerminalPane } from './components/TerminalPane';
export { TerminalBanner } from './components/TerminalBanner';
export { TerminalInputOverlay } from './components/input/TerminalInputOverlay';
export { TerminalTabs } from './components/TerminalTabs';
export { TerminalWorkspace } from './components/TerminalWorkspace';

// New architecture: hooks
export { useTerminal } from './hooks/useTerminal';
export type { UseTerminalOptions } from './hooks/useTerminal';
