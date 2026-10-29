import { fitFontToColumns, rowsForHeight } from '../sizing';
import { readTerminalClientConfig } from '../terminalConfig';
import type { Grid } from '../grid';
import type { TerminalCellSize } from '../emulator';

/**
 * The controller surface geometry may use (#2581 SC-06).
 *
 * Geometry owns the *policy* — fixed columns, measured-cell font fit, usable
 * height and rows, deduplicated reporting. The Product layer supplies box
 * measurements (capsule occlusion is a CSS custom property on the observed
 * element); this class never reinterprets Product CSS.
 */
export interface TerminalGeometryHost {
  readonly isObserverReadOnly: boolean;
  readonly statedTerminalCols: number | null;
  readonly cellDimensions: TerminalCellSize;
  publishViewportResize(cols: number, rows: number): void;
  sendResize(cols: number, rows: number): void;
  resizeLocal(cols: number, rows: number): void;
  resizeLocalOrdered(cols: number, rows: number): void;
  measureFont(fontSize: number): TerminalCellSize;
  /**
   * Apply the measured content width to the viewport's CSS contract. Geometry
   * owns the value; the controller owns the DOM write so the registered
   * producer stays the view owner.
   */
  applyContentWidth(container: HTMLElement, contentWidth: number, fits: boolean): void;
}

/**
 * Fixed-column terminal sizing (#2487).
 *
 * The column count is canonical — read once from the build configuration — and
 * is **never** derived from the container width. What adapts:
 *
 * - **font**: the largest size, up to the release maximum, whose measured cell
 *   lets exactly `cols` fit the content box. A wide window keeps the maximum
 *   and caps/centres the terminal; a narrower one shrinks the glyphs rather
 *   than the grid. App/mobile has no application-imposed minimum size: the
 *   fitted font may go below 6 px when the fixed columns require it, and a
 *   positive measured cell is the only intrinsic lower bound.
 * - **rows**: `floor(usable height / measured cell height)`.
 *
 * Geometry is applied through the parser writer so it cannot cross an
 * unfinished ANSI parse (#2283). Only the PTY notification is debounced
 * (200 ms); the first fire, a font-load correction and an explicit takeover
 * report immediately. Repeated identical sizes are not resent, and the ordered
 * writer drops a resize that repeats the grid it already applied (#2581).
 *
 * **Only a width change re-runs the font fit.** A height-only observation
 * recomputes rows from the cell already measured; it must not walk font sizes
 * again (#2581 SC-06).
 */
export class TerminalGeometry {
  private observer: ResizeObserver | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isFirstFire = true;
  private lastContainer = { width: 0, height: 0 };
  /** The element being observed — held for the content/capsule geometry. */
  private container: HTMLElement | null = null;
  /**
   * Whether the cell box has already been through the font-load correction
   * (#1490). Until it has, a provisional status means the grid is still the
   * fallback's and the correction will report the final one. After it has,
   * the box is final: `document.fonts.status` can flip back to `loading` for
   * a lazy face the renderer requested, and treating that as provisional
   * would swallow a real container resize with no correction left to report
   * it (#2132).
   */
  private fontMetricsSettled = false;
  /**
   * The fixed column count to render. Starts at the stated Session value or
   * this build's embedded value, and changes only when the Agent states the
   * Session's authoritative width (#2487).
   */
  private cols: number;
  /** The release's maximum CSS font size; the fit ceiling for both experiences. */
  private readonly webMaxFontSize: number;
  private lastReported: { cols: number; rows: number } | null = null;
  /** The width the current font was fitted for; `null` forces a fit. */
  private fittedWidth: number | null = null;

  constructor(private readonly controller: TerminalGeometryHost) {
    const config = readTerminalClientConfig();
    this.cols = controller.statedTerminalCols ?? config.cols;
    this.webMaxFontSize = config.webMaxFontSize;
  }

  /**
   * Render the Session's authoritative width instead of this client's build
   * value (#2487). Used when the attach reply or the Agent's resize fan-out
   * states a different width; the local fit is recomputed so exactly that many
   * columns are visible.
   */
  adoptSessionCols(cols: number): void {
    if (!Number.isFinite(cols) || cols <= 0 || cols === this.cols) { return; }
    this.cols = cols;
    this.lastReported = null;
    this.fittedWidth = null;
    if (this.lastContainer.width > 0 && this.lastContainer.height > 0) {
      this.remeasure({ ordered: true, fitFont: true });
    }
  }

  observe(container: HTMLElement, cellWidth: number, cellHeight: number): void {
    if (cellWidth <= 0 || cellHeight <= 0) { return; }
    this.dispose();
    // Held for the geometry read: the inset is applied to this element's
    // padding, so reading it back is what tells the grid what the content box
    // left out.
    this.container = container;
    this.isFirstFire = true;
    this.lastContainer = { width: 0, height: 0 };
    this.lastReported = null;
    this.fittedWidth = null;

    this.observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const size = entry.contentRect;
        const widthChanged = this.lastContainer.width !== size.width;
        this.lastContainer = { width: size.width, height: size.height };
        // Fit the font only when the width moved; rows follow the cell xterm
        // has already measured. The content box, not the border box:
        // `contentRect` excludes the container's padding, which is the whole
        // of `--terminal-pad-x` (#1092).
        const grid = this.applyGeometry({ fitFont: widthChanged, ordered: false });
        if (grid === null) { continue; }

        // Only the Controller owns the pane's geometry. An observer's
        // container can resize independently; fitting its own font is local,
        // but its grid follows the authoritative session size. We still
        // publish the measurement for a future explicit takeover.
        if (this.isFirstFire) {
          this.isFirstFire = false;
          if (!this.metricsAreProvisional()) { this.report(grid, { force: true }); }
          continue;
        }
        if (this.metricsAreProvisional()) { continue; }
        if (this.controller.isObserverReadOnly) {
          this.controller.publishViewportResize(grid.cols, grid.rows);
          continue;
        }
        this.report(grid, { force: false });
      }
    });
    this.observer.observe(container);
  }

  /**
   * Recompute the geometry from the last observed container size.
   *
   * `fitFont` is false for a user zoom: the chosen font is kept and only rows
   * are recomputed. It is true after a webfont settles (the first fit used the
   * fallback's cell) and on takeover.
   *
   * `ordered` applies the grid through the parser writer — the adoption path,
   * where correctness is worth a deferred frame (#2286 SC-04).
   */
  remeasure({ ordered = false, fitFont = true }: { ordered?: boolean; fitFont?: boolean } = {}): void {
    this.fontMetricsSettled = true;
    // A zoom keeps the chosen font: the width is no longer fitted for it, so
    // the next width observation (or explicit fit) must measure again.
    if (!fitFont) { this.fittedWidth = null; }
    if (this.lastContainer.width <= 0 || this.lastContainer.height <= 0) { return; }
    const grid = this.applyGeometry({ fitFont, ordered });
    if (grid === null) { return; }
    if (this.controller.isObserverReadOnly) {
      this.controller.publishViewportResize(grid.cols, grid.rows);
      return;
    }
    this.report(grid, { force: true });
  }

  /**
   * Fit (or keep) the font, cap the content width, and return the fixed-cols
   * grid. The local xterm mutation happens here, before any report.
   */
  private applyGeometry(options: { fitFont: boolean; ordered: boolean }): Grid | null {
    const layout = this.measureLayout(options.fitFont);
    if (layout === null) { return null; }
    if (this.container !== null) {
      // The terminal's own content width, used by the stylesheet to cap and
      // centre the xterm. At the minimum font a very narrow box may be smaller
      // than this; the viewport scrolls horizontally rather than dropping a
      // column.
      this.controller.applyContentWidth(this.container, layout.contentWidth, layout.fits);
    }
    const grid = { cols: this.cols, rows: layout.rows };
    if (this.controller.isObserverReadOnly) { return grid; }
    if (options.ordered) {
      this.controller.resizeLocalOrdered(grid.cols, grid.rows);
    } else {
      this.controller.resizeLocal(grid.cols, grid.rows);
    }
    return grid;
  }

  private measureLayout(fitFont: boolean): {
    cell: { width: number; height: number };
    contentWidth: number;
    fits: boolean;
    rows: number;
  } | null {
    const width = this.lastContainer.width;
    const height = this.usableHeight();
    if (width <= 0 || height === null) { return null; }

    let cell: { width: number; height: number };
    let contentWidth: number;
    let fits: boolean;
    // A fit for this width is already installed: re-running it would only
    // measure the same cells again (SC-06).
    if (fitFont && this.fittedWidth !== width) {
      // The release maximum is the fit ceiling for both experiences; the
      // device profile's font only seeds the initial render. App/mobile has no
      // Nession-defined minimum font size: a narrow width at the Session's
      // fixed columns is allowed to choose a size below 6 px (#2592).
      const fit = fitFontToColumns({
        cols: this.cols,
        availableWidth: width,
        maxFontSize: this.webMaxFontSize,
        measureCell: (fontSize) => this.controller.measureFont(fontSize),
      });
      if (fit === null) { return null; }
      this.fittedWidth = width;
      cell = fit.cell;
      contentWidth = fit.contentWidth;
      fits = fit.fits;
    } else {
      cell = this.controller.cellDimensions;
      if (cell.width <= 0 || cell.height <= 0) { return null; }
      contentWidth = this.cols * cell.width;
      fits = contentWidth <= width;
    }

    const rows = rowsForHeight(height, cell.height);
    if (rows === null) { return null; }
    return { cell, contentWidth, fits, rows };
  }

  /**
   * The usable height: the content box plus the capsule band this mode
   * reserves, minus the band itself (#1503). The grid must never draw rows the
   * well is not showing, and the band is chrome drawn over it in both modes.
   */
  private usableHeight(): number | null {
    const container = this.container;
    if (container === null) { return null; }
    const style = getComputedStyle(container);
    const number = (value: string): number => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    };
    const reserved = number(style.paddingBottom);
    const band = number(
      style.getPropertyValue('--nession-local-terminal-capsule-occlusion'),
    );
    return this.lastContainer.height + reserved - band;
  }

  /**
   * Publish and send one geometry, unless it is the duplicate of the last one.
   *
   * `force` is for the paths that must state the size even when nothing moved:
   * a takeover (the transport forgot its last send) and the font-load
   * correction. The drag path leaves it false, so a resize that does not
   * change the grid sends nothing to tmux.
   */
  private report(
    grid: Grid,
    { force }: { force: boolean },
  ): void {
    if (!force
      && this.lastReported?.cols === grid.cols
      && this.lastReported.rows === grid.rows) {
      return;
    }
    this.lastReported = { cols: grid.cols, rows: grid.rows };
    this.controller.publishViewportResize(grid.cols, grid.rows);
    if (this.controller.isObserverReadOnly) { return; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = null;
    if (force) {
      this.controller.sendResize(grid.cols, grid.rows);
      return;
    }
    this.debounceTimer = setTimeout(() => {
      if (!this.controller.isObserverReadOnly) {
        this.controller.sendResize(grid.cols, grid.rows);
      }
    }, 200);
  }

  /**
   * Whether the cell box xterm reports right now is the terminal's **final**
   * one — false while a webfont is still loading.
   *
   * The report that lands in the provisional case is the font-load correction
   * itself: `XtermEmulator.remeasureOnFontLoad` waits on the same `ready` and
   * calls back through `onCellSizeChange`, which is this controller's
   * `remeasure()`. Reporting from both would send the same size twice.
   * `document.fonts.ready` resolves when the loading finishes *or fails*, so
   * a face that never arrives still releases the report.
   */
  private metricsAreProvisional(): boolean {
    // Only before the correction: a later `loading` status is some other face
    // the renderer asked for, not a measurement this grid was computed from.
    if (this.fontMetricsSettled) { return false; }
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    return fonts?.status === 'loading';
  }

  /** Cancel a resize captured under a lease that this client has lost. */
  cancelPending(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = null;
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.container = null;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = null;
  }
}
