import type { InputSource } from '../types';

/**
 * Manages the currently active input source.
 * Layer 1 of the two-layer input system: detects where input comes from.
 */
export class InputSourceManager {
  private activeSource: InputSource | null = null;
  private onSourceChangeCallbacks: Array<(source: InputSource) => void> = [];

  /**
   * Set the active input source.
   * If source is the same as current, does nothing.
   */
  setActiveSource(source: InputSource): void {
    if (this.activeSource === source) {
      return;
    }

    this.activeSource = source;

    // Trigger callbacks for UI response
    this.onSourceChangeCallbacks.forEach((cb) => cb(source));
  }

  /** Get the currently active input source. */
  getActiveSource(): InputSource | null {
    return this.activeSource;
  }

  /**
   * Register a callback for source changes.
   * Returns an unsubscribe function.
   */
  onSourceChange(callback: (source: InputSource) => void): () => void {
    this.onSourceChangeCallbacks.push(callback);

    return () => {
      const index = this.onSourceChangeCallbacks.indexOf(callback);
      if (index >= 0) {
        this.onSourceChangeCallbacks.splice(index, 1);
      }
    };
  }

  /** Dispose and reset state. */
  dispose(): void {
    this.onSourceChangeCallbacks = [];
    this.activeSource = null;
  }
}
