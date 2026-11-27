import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const context = vm.createContext({});
vm.runInContext(readFileSync(join(here, 'gesture.js'), 'utf8'), context);
const G = context.NessionPullGesture;

function contact(surface = 'sessions', atTop = true) {
  return G.createContact({ surface, atTop });
}

test('a short vertical pull cancels without committing', () => {
  const c = contact();
  assert.equal(G.move(c, 0, 30).action, 'pull');
  assert.equal(G.release(c).action, 'cancel');
  assert.equal(c.committed, false);
});

test('a qualified vertical pull commits exactly once', () => {
  const c = contact();
  G.move(c, 0, 80);
  assert.equal(G.release(c).action, 'commit');
  // A repeated release must not fire a second request.
  assert.equal(G.release(c).action, 'none');
});

test('the threshold is the raw travel, not the resisted distance', () => {
  const c = contact();
  const result = G.move(c, 0, G.RELEASE_THRESHOLD_PX);
  assert.equal(result.distance, G.RELEASE_THRESHOLD_PX * G.RESISTANCE);
  assert.equal(G.release(c).action, 'commit');

  const under = contact();
  G.move(under, 0, G.RELEASE_THRESHOLD_PX - 1);
  assert.equal(G.release(under).action, 'cancel');
});

test('the first movement past the lock fixes the axis for the contact', () => {
  const c = contact();
  assert.equal(G.move(c, 3, 2).action, 'pending');
  assert.equal(G.move(c, 20, 6).action, 'surrender');
  // Dragging back down afterwards must not arm the pull.
  assert.equal(G.move(c, 20, 90).action, 'surrender');
  assert.equal(G.release(c).action, 'cancel');
});

test('a vertical lock is not stolen by later horizontal drift', () => {
  const c = contact();
  assert.equal(G.move(c, 2, 20).action, 'pull');
  assert.equal(G.move(c, 40, 80).action, 'pull');
  assert.equal(G.release(c).action, 'commit');
});

test('a list that is not at top scrolls instead of pulling', () => {
  const c = contact('sessions', false);
  assert.equal(G.move(c, 0, 90).action, 'scroll');
  assert.equal(G.release(c).action, 'cancel');
});

test('nested scroller and Terminal contacts never arm the host pull', () => {
  for (const surface of ['nested', 'terminal', 'files', 'editor']) {
    const c = contact(surface, true);
    assert.equal(G.move(c, 0, 90).action, 'scroll', surface);
    assert.equal(G.release(c).action, 'cancel', surface);
  }
});

test('an upward drag is ordinary scrolling even at top', () => {
  const c = contact();
  assert.equal(G.move(c, 0, -60).action, 'scroll');
  assert.equal(G.release(c).action, 'cancel');
});

test('pull distance is resisted and capped', () => {
  const c = contact();
  assert.equal(G.move(c, 0, 40).distance, 20);
  assert.equal(G.move(c, 0, 1000).distance, G.MAX_PULL_PX);
});

test('the prototype assets are present and relative', () => {
  const html = readFileSync(join(here, 'index.html'), 'utf8');
  for (const asset of ['../prototype-frame-2758/frame.css', '../prototype-frame-2758/frame.js', 'gesture.js']) {
    assert.ok(html.includes(asset), `missing ${asset}`);
  }
  assert.ok(html.includes('data-nession-prototype-frame="v1"'));
  assert.ok(html.includes('data-nession-gallery-link'));
  assert.ok(html.includes('data-nession-source-link'));
  // No absolute or remote asset URLs in the product page.
  assert.ok(!/src="https?:/.test(html));
  assert.ok(!/href="https?:[^"]*\.(css|js)"/.test(html));
});
