/**
 * OSC 52 / OSC 5522 clipboard protocol (#2598).
 *
 * One instance belongs to one live terminal/viewport. It is deliberately
 * React-free and xterm-free: {@link XtermEmulator} feeds it parsed OSC and
 * private-mode sequences together with the ordered writer's provenance, and
 * this class owns the protocol state machine, bounds and replies. Clipboard
 * *effects* are delegated to {@link ClipboardEffectPort}; the browser adapter is
 * the only place that touches `navigator.clipboard`.
 *
 * Security rules this module owns:
 *
 * - Only live stream output may request an effect. Bootstrap/replay writes and
 *   observer clients are refused (no write, no read, no paste announcement).
 * - A read is served only from the one-time offer created by an explicit user
 *   paste whose unguessable `pw` the application echoes back. There is no
 *   spontaneous read path.
 * - OSC 52 reads (`?`) stay disabled; no local clipboard bytes can be exposed
 *   by remote output.
 * - Payload bytes are never logged and are dropped with the offer/session.
 */
import type { TerminalWriteOrigin } from '../emulator';
import { decodeBase64, decodeBase64Text, encodeBase64, encodeBase64Text } from './base64';
import {
  formatOsc5522,
  formatPrivateModeReport,
  isValidClipboardMime,
  parseOsc5522Frame,
  sanitizeClipboardId,
  type Osc5522Frame,
} from './osc';

/** The Kitty spec requires accepting at least this much clipboard write data. */
export const KITTY_MIN_CLIPBOARD_WRITE_BYTES = 64 * 1024 * 1024;
/** Maximum decoded bytes per `read` DATA or `wdata` packet. */
export const CLIPBOARD_PACKET_BYTES = 4096;
/** 4096 bytes with mandatory padding. */
const MAX_WDATA_ENCODED_CHUNK = Math.ceil(CLIPBOARD_PACKET_BYTES / 3) * 4;

export type ClipboardEffectFailureCode = 'EPERM' | 'EIO';

/** A clipboard effect was refused; the protocol maps the code to its reply. */
export class ClipboardEffectError extends Error {
  constructor(readonly code: ClipboardEffectFailureCode) {
    super(code);
    this.name = 'ClipboardEffectError';
  }
}

export type ClipboardNotice =
  | { readonly kind: 'copy-required'; readonly text: string }
  | { readonly kind: 'write-denied' }
  | { readonly kind: 'unsupported-image-paste' }
  | { readonly kind: 'image-too-large' };

/**
 * The effects a live, authorized terminal may perform.
 *
 * `writeClipboard` receives every representation of one clipboard write —
 * the requested MIME types plus their aliases — because they belong to a single
 * clipboard item; writing them one at a time would replace the previous one.
 *
 * The two gesture members are optional because not every port has a browser
 * to ask (#2614): a test double may implement only the async writes. The
 * surface asks them through `TerminalController`, never directly.
 */
export interface ClipboardEffectPort {
  writeText(text: string): Promise<void>;
  writeClipboard(variants: ReadonlyMap<string, Uint8Array>): Promise<void>;
  /** Whether `writeText` can act on this origin without a user gesture. */
  writeTextIsProgrammatic?(): boolean;
  /** Synchronous user-gesture text write; whether the browser accepted it. */
  writeTextFromGesture?(text: string): boolean;
  notice(notice: ClipboardNotice): void;
}

/** Clipboard content captured from one user paste event. */
export interface ClipboardPasteItems {
  readonly text?: string;
  readonly images?: readonly { readonly mime: string; readonly bytes: Uint8Array }[];
}

export interface ClipboardProtocolLimits {
  /** Total decoded bytes one `type=write` session may carry. */
  readonly maxWriteBytes: number;
  /** Largest OSC 52 text write this terminal will apply. */
  readonly maxOsc52Bytes: number;
  /** OSC 52 text retained for the explicit user-click copy prompt. */
  readonly maxOsc52PromptBytes: number;
  /** Encoded bytes accepted for a read request's MIME list. */
  readonly maxReadRequestBytes: number;
  readonly maxMimeTypes: number;
  /** A write session that goes idle this long fails with EIO. */
  readonly writeTimeoutMs: number;
  /** How long a user paste's one-time read authorization stays valid. */
  readonly offerTimeoutMs: number;
}

const DEFAULT_LIMITS: ClipboardProtocolLimits = {
  maxWriteBytes: KITTY_MIN_CLIPBOARD_WRITE_BYTES,
  maxOsc52Bytes: 1024 * 1024,
  maxOsc52PromptBytes: 256 * 1024,
  maxReadRequestBytes: 64 * 1024,
  maxMimeTypes: 32,
  writeTimeoutMs: 60_000,
  offerTimeoutMs: 120_000,
};

export interface ClipboardProtocolOptions {
  /** Ordered PTY input channel; protocol replies travel through it. */
  sendToPty: (data: string) => void;
  effects: ClipboardEffectPort;
  /**
   * Whether this client may perform clipboard effects right now: attached,
   * foreground/visible, and the authorized Controller (never a passive
   * observer). Evaluated at effect time, not at construction.
   */
  isAuthorized: () => boolean;
  limits?: Partial<ClipboardProtocolLimits>;
  /** One-time paste passwords; injectable for deterministic tests. */
  createPassword?: () => string;
}

interface WriteStream {
  readonly parts: string[];
  encodedLength: number;
}

interface WriteSession {
  readonly id: string;
  failed: boolean;
  currentMime: string | null;
  readonly streams: Map<string, WriteStream>;
  /** Target MIME → additional MIME types sharing its bytes. */
  readonly aliases: Map<string, string[]>;
  encodedTotal: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PasteOffer {
  readonly password: string;
  readonly mimes: Map<string, Uint8Array>;
  timer: ReturnType<typeof setTimeout> | null;
}

function defaultPassword(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return encodeBase64(bytes);
}

/** Largest encoded stream that can still decode to `maxWriteBytes`. */
function maxEncodedWriteLength(maxWriteBytes: number): number {
  return Math.ceil(maxWriteBytes / 3) * 4;
}

export class TerminalClipboardProtocol {
  private readonly limits: ClipboardProtocolLimits;
  private readonly createPassword: () => string;
  private pasteEventMode = false;
  private writeSession: WriteSession | null = null;
  private applying = false;
  private offer: PasteOffer | null = null;
  /**
   * Newest live stream epoch this protocol has been asked to interpret. Frames
   * from an older queued epoch are still accepted only while they are the
   * newest seen: the ordered writer parses in arrival order, so an old epoch
   * cannot appear after a newer one.
   */
  private latestEpoch: number | undefined;
  private disposed = false;

  constructor(private readonly options: ClipboardProtocolOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.createPassword = options.createPassword ?? defaultPassword;
  }

  get isPasteEventMode(): boolean {
    return this.pasteEventMode;
  }

  /**
   * Live and replay both update the current mode: it is terminal state, not a
   * side effect. Declared with one parameter so the host contract's extra
   * provenance argument stays optional at this boundary.
   */
  setPasteEventMode(enabled: boolean): void {
    if (this.disposed) { return; }
    this.pasteEventMode = enabled;
  }

  /** `CSI ? 5522 $ p` — truthful DECRPM (1 = set, 2 = reset). */
  reportModeQuery(): void {
    if (this.disposed) { return; }
    this.options.sendToPty(formatPrivateModeReport(5522, this.pasteEventMode ? 1 : 2));
  }

  /** OSC 52 write. Reads (`?`) are deliberately not implemented. */
  handleOsc52(raw: string, origin: TerminalWriteOrigin): boolean {
    if (this.disposed || !this.isLive(origin)) { return true; }
    const parts = raw.split(';');
    const payload = parts.pop() ?? '';
    if (parts.length === 0 || payload === '' || payload === '?') { return true; }
    // Selections name clipboard (`c`), primary (`p`), etc. Nession owns only
    // the system clipboard; a request that does not include `c` is ignored
    // without inventing an error reply (OSC 52 has no status channel).
    const selectsClipboard = parts.length === 0
      || parts.includes('c')
      || parts.every((selection) => selection === '');
    if (!selectsClipboard) { return true; }
    const bytes = decodeBase64(payload);
    if (typeof bytes === 'string' || bytes.byteLength > this.limits.maxOsc52Bytes) {
      return true;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return true;
    }
    if (!this.options.isAuthorized()) { return true; }
    void this.options.effects.writeText(text).catch(() => {
      if (this.disposed) { return; }
      this.options.effects.notice(text.length <= this.limits.maxOsc52PromptBytes
        ? { kind: 'copy-required', text }
        : { kind: 'write-denied' });
    });
    return true;
  }

  /** OSC 5522 packet. */
  handleOsc5522(raw: string, origin: TerminalWriteOrigin): boolean {
    if (this.disposed) { return true; }
    if (!this.isLive(origin)) { return true; }
    const frame = parseOsc5522Frame(raw);
    if (!frame) { return true; }
    switch (frame.metadata.get('type')) {
      case 'read':
        this.handleRead(frame);
        break;
      case 'write':
        this.beginWrite(frame);
        break;
      case 'wdata':
        this.handleWriteData(frame);
        break;
      case 'walias':
        this.handleWriteAlias(frame);
        break;
      default:
        break;
    }
    return true;
  }

  /**
   * A user pasted. Text keeps its existing bracketed-paste path outside this
   * class; this captures the same content as a one-time protocol offer and, in
   * paste-event mode, announces the available MIME types to the active pane.
   */
  userPasted(items: ClipboardPasteItems): void {
    if (this.disposed || !this.options.isAuthorized()) { return; }
    const mimes = new Map<string, Uint8Array>();
    let bytes = 0;
    const text = items.text ?? '';
    if (!this.pasteEventMode && text.length === 0 && (items.images?.length ?? 0) > 0) {
      this.options.effects.notice({ kind: 'unsupported-image-paste' });
      return;
    }
    if (text.length > 0) {
      const encoded = new TextEncoder().encode(text);
      mimes.set('text/plain', encoded);
      bytes += encoded.byteLength;
    }
    for (const image of items.images ?? []) {
      if (!isValidClipboardMime(image.mime)) { continue; }
      mimes.set(image.mime, image.bytes);
      bytes += image.bytes.byteLength;
    }
    if (mimes.size === 0) { return; }
    if (bytes > this.limits.maxWriteBytes || mimes.size > this.limits.maxMimeTypes) {
      this.options.effects.notice({ kind: 'image-too-large' });
      return;
    }
    this.dropOffer();
    if (!this.pasteEventMode) { return; }
    const password = this.createPassword();
    const timer = setTimeout(() => {
      if (this.offer?.password === password) { this.dropOffer(); }
    }, this.limits.offerTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
    this.offer = { password, mimes, timer };
    this.options.sendToPty(formatOsc5522(
      [
        ['type', 'read'],
        ['pw', encodeBase64Text(password)],
        ['name', encodeBase64Text('Paste event')],
      ],
      encodeBase64Text([...mimes.keys()].join(' ')),
    ));
  }

  dispose(): void {
    this.disposed = true;
    this.dropOffer();
    if (this.writeSession?.timer) { clearTimeout(this.writeSession.timer); }
    this.writeSession = null;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  private handleRead(frame: Osc5522Frame): void {
    const id = sanitizeClipboardId(frame.metadata.get('id'));
    if (frame.payload.length > this.limits.maxReadRequestBytes) {
      this.replyRead(id, 'EINVAL');
      return;
    }
    const requestedText = decodeBase64Text(frame.payload);
    if (requestedText === null || requestedText.length === 0) { return; }
    const requested = [...new Set(requestedText.split(' ').filter(Boolean))];
    if (requested.some((mime) => mime !== '.' && !isValidClipboardMime(mime))) {
      this.replyRead(id, 'EINVAL');
      return;
    }
    if (requested.length === 1 && requested[0] === '.') {
      this.replyReadListing(id);
      return;
    }
    if (frame.metadata.get('loc') === 'primary') {
      this.replyRead(id, 'ENOSYS');
      return;
    }
    if (!this.options.isAuthorized()) {
      this.replyRead(id, 'EPERM');
      return;
    }
    const offer = this.offer;
    if (!offer) {
      this.replyRead(id, 'EPERM');
      return;
    }
    const password = decodeBase64Text(frame.metadata.get('pw') ?? '');
    if (password === null || password !== offer.password) {
      this.replyRead(id, 'EPERM');
      return;
    }
    if (requested.some((mime) => !offer.mimes.has(mime))) {
      this.replyRead(id, 'ENOSYS');
      return;
    }
    this.replyRead(id, 'OK');
    for (const mime of requested) {
      const data = offer.mimes.get(mime)!;
      const encodedMime = encodeBase64Text(mime);
      for (let offset = 0; offset < data.byteLength; offset += CLIPBOARD_PACKET_BYTES) {
        const chunk = data.subarray(offset, offset + CLIPBOARD_PACKET_BYTES);
        this.options.sendToPty(formatOsc5522(
          [['type', 'read'], ['status', 'DATA'], ['mime', encodedMime], ...idPair(id)],
          encodeBase64(chunk),
        ));
      }
    }
    this.options.sendToPty(formatOsc5522(
      [['type', 'read'], ['status', 'DONE'], ...idPair(id)],
    ));
    // One explicit paste authorizes one read.
    this.dropOffer();
  }

  private replyReadListing(id: string): void {
    this.replyRead(id, 'OK');
    for (const mime of this.offer?.mimes.keys() ?? []) {
      this.options.sendToPty(formatOsc5522(
        [['type', 'read'], ['status', 'DATA'], ['mime', encodeBase64Text(mime)], ...idPair(id)],
        '',
      ));
    }
    this.options.sendToPty(formatOsc5522(
      [['type', 'read'], ['status', 'DONE'], ...idPair(id)],
    ));
  }

  private replyRead(id: string, status: string): void {
    this.options.sendToPty(formatOsc5522(
      [['type', 'read'], ['status', status], ...idPair(id)],
    ));
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  private beginWrite(frame: Osc5522Frame): void {
    const id = sanitizeClipboardId(frame.metadata.get('id'));
    if (!this.options.isAuthorized()) {
      this.replyWrite(id, 'EPERM');
      return;
    }
    if (frame.metadata.get('loc') === 'primary') {
      this.replyWrite(id, 'ENOSYS');
      return;
    }
    // A failed write keeps a discard marker so later packets are ignored, not
    // answered with EINVAL; the next `type=write` still starts a new session.
    if ((this.writeSession !== null && !this.writeSession.failed) || this.applying) {
      this.replyWrite(id, 'EBUSY');
      return;
    }
    this.writeSession = {
      id,
      failed: false,
      currentMime: null,
      streams: new Map(),
      aliases: new Map(),
      encodedTotal: 0,
      timer: null,
    };
    this.touchWriteSession();
  }

  private handleWriteData(frame: Osc5522Frame): void {
    const session = this.writeSession;
    if (session === null) {
      this.replyWrite(sanitizeClipboardId(frame.metadata.get('id')), 'EINVAL');
      return;
    }
    if (session.failed || this.applying) { return; }
    this.touchWriteSession();
    const encodedMime = frame.metadata.get('mime');
    if (encodedMime !== undefined) {
      const mime = decodeBase64Text(encodedMime);
      if (mime === null || !isValidClipboardMime(mime)) {
        this.failWrite('EINVAL');
        return;
      }
      if (!session.streams.has(mime)) {
        if (session.streams.size >= this.limits.maxMimeTypes) {
          this.failWrite('EFBIG');
          return;
        }
        session.streams.set(mime, { parts: [], encodedLength: 0 });
      }
      session.currentMime = mime;
    }
    if (frame.payload.length === 0) {
      if (encodedMime === undefined) {
        void this.finishWrite(session);
      }
      return;
    }
    if (session.currentMime === null) {
      this.failWrite('EINVAL');
      return;
    }
    if (frame.payload.length > MAX_WDATA_ENCODED_CHUNK) {
      this.failWrite('EINVAL');
      return;
    }
    const stream = session.streams.get(session.currentMime)!;
    stream.parts.push(frame.payload);
    stream.encodedLength += frame.payload.length;
    session.encodedTotal += frame.payload.length;
    // Padding makes the encoded length an upper bound, not an estimate: a
    // stream whose *encoded* length exceeds the bound cannot decode within it,
    // while the exact decoded size is enforced when the write finishes. This
    // keeps a stream that decodes to exactly `maxWriteBytes` (the spec's 64 MiB
    // minimum) acceptable.
    if (session.encodedTotal > maxEncodedWriteLength(this.limits.maxWriteBytes)) {
      this.failWrite('EFBIG');
    }
  }

  private handleWriteAlias(frame: Osc5522Frame): void {
    const session = this.writeSession;
    if (session === null) {
      this.replyWrite(sanitizeClipboardId(frame.metadata.get('id')), 'EINVAL');
      return;
    }
    if (session.failed || this.applying) { return; }
    this.touchWriteSession();
    const target = decodeBase64Text(frame.metadata.get('mime') ?? '');
    const aliasList = decodeBase64Text(frame.payload);
    if (target === null || aliasList === null || !isValidClipboardMime(target)) {
      this.failWrite('EINVAL');
      return;
    }
    const aliases = aliasList.split(' ').filter(Boolean);
    if (aliases.length === 0 || aliases.some((alias) => !isValidClipboardMime(alias))) {
      this.failWrite('EINVAL');
      return;
    }
    session.aliases.set(target, [...(session.aliases.get(target) ?? []), ...aliases]);
  }

  private async finishWrite(session: WriteSession): Promise<void> {
    this.clearWriteTimer(session);
    this.applying = true;
    const decoded = new Map<string, Uint8Array>();
    for (const [mime, stream] of session.streams) {
      const bytes = decodeBase64(stream.parts.join(''));
      if (typeof bytes === 'string') {
        this.failFinishedWrite('EINVAL');
        return;
      }
      decoded.set(mime, bytes);
    }
    for (const target of session.aliases.keys()) {
      if (!decoded.has(target)) {
        this.failFinishedWrite('EINVAL');
        return;
      }
    }
    let total = 0;
    for (const bytes of decoded.values()) { total += bytes.byteLength; }
    if (total > this.limits.maxWriteBytes) {
      this.failFinishedWrite('EFBIG');
      return;
    }
    if (decoded.size === 0) {
      // An empty write carries no clipboard data; acknowledge it without
      // touching the user's clipboard.
      this.applying = false;
      this.writeSession = null;
      this.replyWrite(session.id, 'DONE');
      return;
    }
    const variants = new Map<string, Uint8Array>();
    for (const [mime, bytes] of decoded) {
      variants.set(mime, bytes);
      for (const alias of session.aliases.get(mime) ?? []) { variants.set(alias, bytes); }
    }
    let failure: ClipboardEffectFailureCode | null = null;
    try {
      await this.options.effects.writeClipboard(variants);
    } catch (error) {
      failure = error instanceof ClipboardEffectError ? error.code : 'EIO';
    }
    this.applying = false;
    this.writeSession = null;
    if (this.disposed) { return; }
    if (failure === null) {
      this.replyWrite(session.id, 'DONE');
    } else {
      this.replyWrite(session.id, failure);
      if (failure === 'EPERM') { this.options.effects.notice({ kind: 'write-denied' }); }
    }
  }

  /** Fail after the final packet: keep the discard marker until a new write. */
  private failFinishedWrite(status: string): void {
    this.applying = false;
    const session = this.writeSession;
    if (session === null) { return; }
    this.clearWriteTimer(session);
    session.failed = true;
    session.streams.clear();
    session.aliases.clear();
    session.currentMime = null;
    this.replyWrite(session.id, status);
  }

  private failWrite(status: string): void {
    const session = this.writeSession;
    if (session === null) { return; }
    this.clearWriteTimer(session);
    session.failed = true;
    // Per the spec the failed write stays discarded until a new `type=write`;
    // the marker session is what makes later packets ignored, not EINVAL.
    session.streams.clear();
    session.aliases.clear();
    this.replyWrite(session.id, status);
  }

  private touchWriteSession(): void {
    const session = this.writeSession;
    if (session === null) { return; }
    this.clearWriteTimer(session);
    session.timer = setTimeout(() => {
      if (this.writeSession === session) {
        session.failed = true;
        this.writeSession = null;
        this.replyWrite(session.id, 'EIO');
      }
    }, this.limits.writeTimeoutMs);
    (session.timer as { unref?: () => void }).unref?.();
  }

  private clearWriteTimer(session: WriteSession): void {
    if (session.timer !== null) { clearTimeout(session.timer); }
    session.timer = null;
  }

  private replyWrite(id: string, status: string): void {
    if (this.disposed) { return; }
    this.options.sendToPty(formatOsc5522(
      [['type', 'write'], ['status', status], ...idPair(id)],
    ));
  }

  private dropOffer(): void {
    if (this.offer?.timer) { clearTimeout(this.offer.timer); }
    this.offer = null;
  }

  /** A transport swap may start a new stream epoch; stale-epoch checks restart. */
  resetStreamEpoch(): void {
    this.latestEpoch = undefined;
  }

  private isLive(origin: TerminalWriteOrigin): boolean {
    if (origin.source !== 'live') { return false; }
    if (origin.streamEpoch === undefined) { return true; }
    if (this.latestEpoch !== undefined && origin.streamEpoch < this.latestEpoch) {
      return false;
    }
    this.latestEpoch = origin.streamEpoch;
    return true;
  }
}

function idPair(id: string): (readonly [string, string])[] {
  return id.length > 0 ? [['id', id] as const] : [];
}
