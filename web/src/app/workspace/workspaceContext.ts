import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { CapabilityFacts, CapabilityId } from '@/product/capability';
import type { CapsuleExperience } from '@/product/terminal/capsule/types';
import type { DomainState } from '@/product/session/model/domainState';
import type { FileOps } from '@/capabilities/files';
import type { Agent, Session } from '@/types';
import type { GitWorktree } from '@/capabilities/git';
import type { FocusedProject, SessionProjectContext } from '@/product/project/types';

export type Experience = CapsuleExperience;

/**
 * The capabilities that draw a different Workspace view per experience.
 *
 * Each experience supplies a layout for every member (`experiences/{web,app}/workspaceViews.tsx`),
 * so naming them as a union makes a missing one a compile error rather than a
 * binding that resolves to `undefined` at render. Claude Code is deliberately
 * absent: it draws the same view in both experiences, so its binding is
 * contributed whole by the capability instead.
 */
export type WorkspaceViewId = 'files' | 'session' | 'agent' | 'env' | 'sandbox';

/**
 * What caused the Workspace to open, when something did.
 *
 * `#826` requires the Terminal → Workspace transition to preserve context: a
 * user who picked a changed file in a Git Peek lands on that file's diff, not
 * on a capability landing page. The focus is how that survives the surface
 * change — it names the item, and the capability's view decides what naming it
 * means.
 */
export interface CapabilityFocus {
  capabilityId: CapabilityId;
  /** The item within the capability, if the user had picked one. */
  resourceId?: string;
  /** 1-based line when opening a file from the Terminal (#1175). */
  line?: number;
  /** 1-based column when the Terminal reference carried one (#3187). */
  column?: number;
}

/** Everything a Workspace view layout needs from the workspace framework. */
export interface WorkspaceContext {
  session: Session | null;
  agent: Agent | undefined;
  agents: Agent[];
  domain: DomainState | null;
  fileOps: FileOps | null;
  experience: Experience;
  onToolChange: (id: CapabilityId) => void;
  /** Observations about the session, supplied by the app layer (never probed here). */
  facts?: CapabilityFacts;
  /** What opened this view, when the entry carried context (`#826`). */
  focus?: CapabilityFocus;
  /** Called after a capability has applied `focus` so it is not replayed. */
  onFocusConsumed?: () => void;
  /** Nession-owned Session handoff from Git worktrees (#1010). */
  openWorktreeSession?: (worktree: GitWorktree) => Promise<void>;
  /** Focused Session's explicit Project resolution (#3082). */
  focusedProject?: FocusedProject;
  /** The capability currently open on this surface, for the active state. */
  activeCapabilityId?: CapabilityId;
  /** Project-owned content/actions for the focused Session (#3082). */
  sessionProject?: SessionProjectContext;
}


/**
 * A depth a Workspace capability has pushed over its own root (`#1051`).
 *
 * The App composes **one navigation bar per depth**. A capability's view is
 * asked for this when it is showing something deeper than its root; the shell
 * renders the bar for it. That is the split the issue names: the App shell owns
 * navigation chrome, and a capability owns its content and its local actions.
 *
 * It carries no navigation semantics of its own — no "close", no stack, no
 * route — because a capability must not invent global navigation. There is one
 * leave action and the shell decides what the bar does with it.
 */
export interface WorkspacePush {
  /** The pushed page's own name — the header's primary title. */
  title: string;
  /**
   * The real ancestry under the title: the immediate ancestor or bounded
   * parent path. Never a fabricated breadcrumb (#3971).
   *
   * A capability owns its own stack, so it — not the shell — knows whether the
   * depth below is its root, a collection, or another detail. Omitted means the
   * shell may derive only the immediate ancestor's title.
   */
  subtitle?: string;
  /**
   * What Back returns to, named for assistive technology.
   *
   * Omitted means "the capability root", which is the only answer the shell
   * can derive without the capability's ancestry.
   */
  backLabel?: string;
  /**
   * Leave this depth. The capability supplies this, so the guard that protects
   * unsaved state (or any other local precondition) stays with the state it
   * protects rather than being re-implemented by the shell.
   */
  onLeave: () => void;
  /**
   * The stack above this depth, nearest ancestor first, ending at the
   * capability root. The App renders it as the optional Stack Sheet and uses
   * its first entry to name an inner Pop. Omitted when the capability has no
   * deeper hierarchy than the one it is showing.
   */
  ancestors?: readonly WorkspaceStackAncestor[];
  /**
   * Jump to an ancestor by id. The capability supplies this so the same leave
   * guard runs whether the user taps Back, an ancestor, or swipes.
   */
  onJumpToAncestor?: (id: string) => void;
}

/** One ancestor in a capability's pushed stack, nearest first. */
export interface WorkspaceStackAncestor {
  /** Stable identity the capability can navigate to. */
  id: string;
  title: string;
}

/**
 * The semantic action vocabulary the App host renders as icons (#3971).
 *
 * A capability names *meaning*; the App host owns the glyph, geometry, touch
 * target and overflow policy. This keeps two capabilities from drawing two
 * different "refresh" controls, and it is why the capability never passes a
 * ReactNode here.
 */
export type WorkspaceActionIcon =
  | 'browse'
  | 'search'
  | 'create'
  | 'edit'
  | 'refresh'
  | 'filter'
  | 'copy'
  | 'open'
  | 'confirm'
  | 'delete'
  | 'save'
  | 'stack';

/**
 * A capability-local action the App page header may carry beside its title.
 *
 * The header itself stays the shell's — one Back/title band per depth (#1051).
 * A capability contributes the *semantic action* (its name, meaning and what
 * it does), not a second bar: "Browse" belongs to the Claude resource browser,
 * while the geometry, touch target and placement belong to the App chrome.
 * This is the narrow counterpart of the Workspace capsule: switching what a
 * capability shows is not leaving the depth.
 */
export interface WorkspaceHeaderAction {
  /** Stable identity for tests and overflow ownership. */
  id: string;
  /** Visible label; also the default accessible name. */
  label: string;
  /** Accessible name when it should say more than the visible label. */
  ariaLabel?: string;
  /** The semantic icon the App host renders. */
  icon: WorkspaceActionIcon;
  /**
   * Show as a compact icon control. The host renders at most two priority
   * actions; any remaining actions move to More. Destructive actions are never
   * icon-only, regardless of this flag.
   */
  priority?: boolean;
  /**
   * Destructive actions keep readable text in overflow and a confirmation
   * owned by the capability. They are never promoted to an icon-only control.
   */
  destructive?: boolean;
  onActivate: () => void;
}

/**
 * A capability-recorded forward destination (#3971).
 *
 * A leftward inner swipe may only move forward when the capability actually
 * recorded a destination by leaving it. An unknown resource is never entered
 * by gesture. The capability owns the history and invalidation; the shell owns
 * the gesture.
 */
export interface WorkspaceForward {
  title: string;
  onActivate: () => void;
}

/**
 * What an inner Workspace swipe could do at the current depth.
 *
 * Reported upward to the App pager so the single gesture coordinator can route
 * an owned contact to the Workspace stack before the outer spatial navigator.
 * `null` means the depth has no inner stack to operate.
 */
export interface WorkspaceStackReport {
  /** Right swipe: pop one level, named by destination. */
  pop: WorkspaceForward | null;
  /** Left swipe: restore a recorded forward destination. */
  forward: WorkspaceForward | null;
}

/**
 * How an App Workspace view tells the shell which depth it is showing.
 *
 * Handed to the App half of a view by the shell (`WorkspaceShell`), not read out
 * of `WorkspaceContext`: a depth is App composition, and Web's Workspace pane
 * has no navigation hierarchy to declare one to. A view that never pushes
 * simply never calls it.
 */
export interface WorkspaceDepthControl {
  /** Register a pushed depth, or `null` to return to the capability root. */
  setPush: (push: WorkspacePush | null) => void;
  /**
   * Register the contextual actions for the App page header, or `null` to
   * remove them. Optional because a Web view — and a capability with no header
   * action — never has one to declare.
   */
  setActions?: (actions: readonly WorkspaceHeaderAction[] | null) => void;
  /**
   * Register the recorded forward destination, or `null` when there is none.
   * Optional for the same reason as `setActions`.
   */
  setForward?: (forward: WorkspaceForward | null) => void;
}

/** What a Workspace view is handed in both experiences. */
export interface WorkspaceViewProps {
  ctx: WorkspaceContext;
}

/**
 * What an App Workspace view is handed: the context, plus the shell's depth
 * control. The two experiences' prop shapes differ deliberately — `#1051`
 * makes the App's depth part of the App composition rather than something every
 * view is trusted to honour.
 */
export interface WorkspaceAppViewProps extends WorkspaceViewProps {
  depth: WorkspaceDepthControl;
}

/**
 * How a capability draws itself in the Workspace.
 *
 * Only the two things a view owns: the React layouts and the icon its chrome
 * shows. What the capability *is* — its title, whether it is available, whether
 * it deserves a slot — is decided by its provider in the capability layer, so a
 * binding cannot grant itself presence by existing.
 */
export interface WorkspaceViewBinding {
  id: CapabilityId;
  icon: LucideIcon;
  layout: {
    web: ComponentType<WorkspaceViewProps>;
    app: ComponentType<WorkspaceAppViewProps>;
  };
  /**
   * Which App scroll surface this view needs (#4115).
   *
   * Omitted means `document`: the App host wraps the view in its own page
   * scrollport and the capability contributes ordinary content. `bounded` is a
   * declaration that the view is a fill surface with its own internal scroll
   * owner — a collection, reader, diff or editor — for which the host provides
   * the effective height and the measured trailing clearance. A capability
   * that declares `bounded` is responsible for spending
   * `workspaceBoundedScrollClearanceClass` inside that internal scroller; it
   * still never measures the Capsule itself.
   */
  appScroll?: 'document' | 'bounded';
}
