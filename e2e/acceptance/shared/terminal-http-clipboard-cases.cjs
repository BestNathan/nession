'use strict';
// Serve the exact-SHA production Web build from a **real non-loopback HTTP
// origin** (#2614).
//
// The local preview the full-stack runtime starts is `127.0.0.1`, which
// browsers treat as a secure context — it hides exactly the defect #2614 is
// about. Serving the same `web/dist` from the runner's LAN address produces a
// genuine insecure origin (`isSecureContext === false`, no
// `navigator.clipboard`), which is the environment the deployed staging ingress
// presents to users.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

/** The first non-internal IPv4 the host exposes, or null. */
function nonLoopbackIpv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
}

/**
 * Start a static origin for `<repoRoot>/web/dist` on every interface.
 * Returns `{ origin, close }`; `origin` is a LAN address, never localhost.
 */
async function startHttpOrigin(repoRoot) {
  const dist = path.resolve(repoRoot, 'web', 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error('the production Web build is missing: ' + dist);
  }
  const server = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://origin').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    let file = path.resolve(dist, '.' + pathname);
    if (file !== dist && !file.startsWith(dist + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(dist, 'index.html');
    }
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = nonLoopbackIpv4();
  if (!address) {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('no non-loopback IPv4 address is available for a real HTTP origin');
  }
  return {
    origin: 'http://' + address + ':' + server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Open the clipboard fixture from the given origin. */
async function openHttpClipboard(page, origin) {
  await page.goto('about:blank');
  await page.goto(origin + '/#/fixture/clipboard');
  await page.getByTestId('fixture-clipboard').waitFor();
  await page.waitForFunction(() => Boolean(window.clipboardHarness) && Boolean(
    document.querySelector('[data-testid="fixture-clipboard-host"] .xterm-screen'),
  ));
}

/** What the browser reports about its own clipboard capability on this page. */
async function originCapability(page) {
  return page.evaluate(() => ({
    secure: window.isSecureContext === true,
    hasAsyncClipboard: typeof navigator.clipboard !== 'undefined' &&
      typeof navigator.clipboard?.writeText === 'function',
  }));
}

/**
 * Observe the browser's real `copy` event without replacing the product path.
 *
 * `execCommand` is wrapped only to register a listener *after* the product's
 * own (which the product adds before calling the command), so the probe reads
 * the exact text the browser was asked to copy. The wrapper delegates to the
 * real command.
 */
async function armCopyProbe(page) {
  await page.evaluate(() => {
    const original = document.execCommand.bind(document);
    window.__copyProbe = { commands: 0, texts: [], executed: null };
    document.execCommand = (command, ...rest) => {
      if (command !== 'copy') {
        return original(command, ...rest);
      }
      window.__copyProbe.commands += 1;
      const snoop = (event) => {
        window.__copyProbe.texts.push(
          event.clipboardData ? event.clipboardData.getData('text/plain') : null,
        );
      };
      document.addEventListener('copy', snoop, true);
      try {
        const result = original(command, ...rest);
        window.__copyProbe.executed = result;
        return result;
      } finally {
        document.removeEventListener('copy', snoop, true);
      }
    };
  });
}

async function copyProbe(page) {
  return page.evaluate(() => ({
    commands: window.__copyProbe.commands,
    texts: window.__copyProbe.texts.slice(),
    executed: window.__copyProbe.executed,
  }));
}

/** A deterministic PNG-shaped payload; every byte value appears in order. */
function fixtureImage(length = 5000) {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 31) % 256;
  }
  return bytes;
}

module.exports = {
  armCopyProbe,
  copyProbe,
  fixtureImage,
  nonLoopbackIpv4,
  openHttpClipboard,
  originCapability,
  startHttpOrigin,
};
