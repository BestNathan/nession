import type { Terminal, IDisposable } from '@xterm/xterm';
import throttle from 'lodash.throttle';

export type DataCallback = (data: string) => void;
export type CtrlDCallback = () => void;

const MOUSE_THROTTLE_MS = 16;

/** SGR mouse motion events carry the 0x20 (32) "motion" bit in the button code
 *  (e.g. "\x1b[<35;..."). Only these are throttled; press/release/wheel are
 *  passed through immediately so quick clicks are never delayed or merged. */
function isMouseMotion(data: string): boolean {
  if (!data.startsWith('\x1b[<')) { return false; }
  const semicolon = data.indexOf(';', 3);
  const button = Number(data.slice(3, semicolon === -1 ? undefined : semicolon));
  if (!Number.isFinite(button)) { return false; }
  return (button & 32) === 32;
}

export class InputManager {
  private disposables: IDisposable[] = [];
  private dataCallbacks: DataCallback[] = [];
  private ctrlDCallbacks: CtrlDCallback[] = [];
  private sendMouseData: ReturnType<typeof throttle>; // includes .cancel()

  constructor(term: Terminal) {
    this.sendMouseData = throttle(
      (data: string) => {
        for (const cb of this.dataCallbacks) {
          cb(data);
        }
      },
      MOUSE_THROTTLE_MS,
      { leading: true, trailing: true },
    );

    const disposable = term.onData((data: string) => {
      if (data === '\x04') {
        for (const cb of this.ctrlDCallbacks) {
          cb();
        }
        return;
      }
      if (isMouseMotion(data)) {
        this.sendMouseData(data);
      } else {
        for (const cb of this.dataCallbacks) {
          cb(data);
        }
      }
    });
    this.disposables.push(disposable);
  }

  onData(cb: DataCallback): void {
    this.dataCallbacks.push(cb);
  }

  onCtrlD(cb: CtrlDCallback): void {
    this.ctrlDCallbacks.push(cb);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.dataCallbacks = [];
    this.ctrlDCallbacks = [];
    this.sendMouseData.cancel();
  }
}
