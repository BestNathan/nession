// Legacy manager classes (kept for backward compatibility)
export { AddonManager } from './AddonManager';
export { Renderer } from './Renderer';
export { ThemeManager, CATPPUCCIN_MOCHA } from './ThemeManager';
export { ConnectionManager } from './ConnectionManager';
export { MouseIntentResolver } from './MouseIntentResolver';
export { FontSizeManager } from './FontSizeManager';
export { PROFILES, detectProfile } from './DeviceProfile';
export type {
  DeviceProfile,
  ConnectionOptions,
  ReconnectBanner,
} from './types';

// New architecture: controller
export { TerminalController, ResizeController } from './controller/TerminalController';

// New architecture: instance
export { TerminalInstance } from './instance/TerminalInstance';
export type { TerminalInstanceOptions } from './types';

// New architecture: input
export { InputRouter } from './input/InputRouter';
export { InputSourceManager } from './input/InputSourceManager';
export { TerminalInputHandler } from './input/TerminalInputHandler';
export type { InputHandler } from './input/InputHandler';
export type { InputSource, InputEvent } from './types';

// New architecture: transport
export type { TerminalTransport } from './transport/TerminalTransport';

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
export { useTerminalStateMachine } from './hooks/useTerminalStateMachine';
export { useTerminal } from './hooks/useTerminal';
export type { UseTerminalOptions } from './hooks/useTerminal';
