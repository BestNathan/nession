import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { FontSizeManager } from '../FontSizeManager';

describe('FontSizeManager', () => {
  let term: Terminal;
  let onCellSizeChange: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    term = new Terminal({ fontSize: 14 });
    onCellSizeChange = vi.fn<() => void>();
  });

  afterEach(() => { term.dispose(); });

  it('getSize returns current terminal fontSize', () => {
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    expect(mgr.getSize()).toBe(14);
  });

  it('zoomIn increases fontSize by 1 and notifies', () => {
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.zoomIn();
    expect(term.options.fontSize).toBe(15);
    expect(mgr.getSize()).toBe(15);
    expect(onCellSizeChange).toHaveBeenCalledTimes(1);
  });

  it('zoomOut decreases fontSize by 1 and notifies', () => {
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.zoomOut();
    expect(term.options.fontSize).toBe(13);
    expect(onCellSizeChange).toHaveBeenCalledTimes(1);
  });

  it('zoomIn clamps to MAX_FONT (40) and does not notify past ceiling', () => {
    term.options.fontSize = 40;
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.zoomIn();
    expect(term.options.fontSize).toBe(40);
    expect(onCellSizeChange).not.toHaveBeenCalled();
  });

  it('zoomOut clamps to MIN_FONT (8) and does not notify past floor', () => {
    term.options.fontSize = 8;
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.zoomOut();
    expect(term.options.fontSize).toBe(8);
    expect(onCellSizeChange).not.toHaveBeenCalled();
  });

  it('reset restores default and notifies when different from current', () => {
    term.options.fontSize = 20;
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.reset();
    expect(term.options.fontSize).toBe(14);
    expect(onCellSizeChange).toHaveBeenCalledTimes(1);
  });

  it('reset is a no-op when already at default (no notify)', () => {
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.reset();
    expect(onCellSizeChange).not.toHaveBeenCalled();
  });

  it('calls term.refresh after fontSize change so xterm re-measures cells', () => {
    const refreshSpy = vi.spyOn(term, 'refresh');
    const mgr = new FontSizeManager(term, onCellSizeChange, 14);
    mgr.zoomIn();
    expect(refreshSpy).toHaveBeenCalledWith(0, term.rows - 1);
  });
});
