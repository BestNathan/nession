'use strict';
// Shared browser/runtime machinery for the #2598 clipboard Cases.
//
// Every browser Case drives `/fixture/clipboard`, which mounts the production
// TerminalController, ordered writer, xterm parser, OSC 52/5522 protocol and
// browser-clipboard adapter over a harness transport. Bytes injected here take
// the same path live output does; nothing about the protocol is reimplemented
// in the fixture.
const crypto = require('node:crypto');
const { verifiedRuntime } = require('./foreground-resume-browser.cjs');

async function openClipboardFixture(page) {
  // Leave the document first: a second goto to the same hash URL is a
  // same-document navigation and would keep the previous harness page.
  await page.goto('about:blank');
  await page.goto('/#/fixture/clipboard');
  await page.getByTestId('fixture-clipboard').waitFor();
  await page.waitForFunction(() => Boolean(window.clipboardHarness));
  // The fixture renders with xterm's canvas renderer: `.xterm-rows` only
  // exists for the DOM renderer, `.xterm-screen` is the renderer-neutral node.
  await page.waitForFunction(() => Boolean(
    document.querySelector('[data-testid="fixture-clipboard-host"] .xterm-screen'),
  ));
}

async function emit(page, text, options) {
  await page.evaluate(({ value, extra }) => {
    window.clipboardHarness.emit(value, extra);
  }, { value: text, extra: options });
}

async function sentFrames(page) {
  return page.evaluate(() => window.clipboardHarness.sent.slice());
}

async function setObserver(page, readOnly) {
  await page.evaluate((value) => {
    window.clipboardHarness.setObserver(value);
  }, readOnly);
}

/**
 * Record every `navigator.clipboard.writeText` call. The wrapper calls the
 * real method, so the clipboard value is still written; tests read both the
 * call log and the value back.
 */
async function recordClipboardTextWrites(page) {
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const original = clipboard.writeText.bind(clipboard);
    window.__clipboardTextWrites = [];
    clipboard.writeText = async (text) => {
      window.__clipboardTextWrites.push(text);
      return original(text);
    };
  });
}

async function clipboardTextWrites(page) {
  return page.evaluate(() => window.__clipboardTextWrites.slice());
}

async function readClipboardText(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

/**
 * Dispatch a browser paste with exactly the supplied clipboard content. A
 * DataTransfer built in the page is the only way to present image data to the
 * real `paste` listener deterministically; the bytes are real.
 */
async function dispatchPaste(page, items) {
  const payload = items.images
    ? items.images.map((image) => ({ mime: image.mime, bytes: Buffer.from(image.bytes).toString('base64') }))
    : [];
  return page.evaluate(({ text, images }) => {
    const data = new DataTransfer();
    if (text) { data.setData('text/plain', text); }
    for (const image of images) {
      const binary = atob(image.bytes);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      data.items.add(new File([bytes], 'clipboard-image', { type: image.mime }));
    }
    const target = document.querySelector('.xterm-helper-textarea') || document.querySelector('.xterm');
    if (!target) { throw new Error('the terminal paste target is missing'); }
    const event = new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true,
    });
    return { delivered: !target.dispatchEvent(event), defaultPrevented: event.defaultPrevented };
  }, { text: items.text ?? '', images: payload });
}

/** Parse the OSC 5522 frames a TUI would see. */
function parseFrames(frames) {
  return frames.map((frame) => {
    const body = frame.slice('\x1b]5522;'.length, -2);
    const separator = body.indexOf(';');
    const metadataText = separator < 0 ? body : body.slice(0, separator);
    const payload = separator < 0 ? '' : body.slice(separator + 1);
    const metadata = new Map();
    for (const pair of metadataText.split(':')) {
      const equals = pair.indexOf('=');
      if (equals > 0) { metadata.set(pair.slice(0, equals), pair.slice(equals + 1)); }
    }
    return { metadata, payload };
  });
}

function decodeBase64(value) {
  return Buffer.from(value, 'base64');
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** The one-time password from a paste announcement's metadata. */
function announcementPassword(frames) {
  for (const frame of parseFrames(frames)) {
    if (frame.metadata.get('type') === 'read' && frame.metadata.has('pw')) {
      return Buffer.from(frame.metadata.get('pw'), 'base64').toString('utf8');
    }
  }
  return null;
}

module.exports = {
  verifiedRuntime,
  openClipboardFixture,
  emit,
  sentFrames,
  setObserver,
  recordClipboardTextWrites,
  clipboardTextWrites,
  readClipboardText,
  dispatchPaste,
  parseFrames,
  decodeBase64,
  sha256Hex,
  announcementPassword,
};
