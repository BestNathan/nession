import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = [
  "agent-process-discovery-2514", "ai-conversation-2254", "ai-workspace-2221",
  "claude-memory-2689", "environment-session-2654", "files-workspace-2751",
  "git-github-1290", "mobile-swipe-2724", "pages-knowledge-2664",
  "session-metadata-2789", "terminal-clipboard-2598", "terminal-direction-2657",
  "terminal-fixed-cols-2487", "terminal-keys-commands-2710"
];

for (const slug of names) {
  test(slug + ": exactly one publisher-safe, interactive review page", () => {
    const html = readFileSync(join(root, slug, "index.html"), "utf8");
    const count = needle => html.split(needle).length - 1;
    assert.match(html, /<body\b[^>]*data-nession-prototype-frame="v1"/i);
    assert.equal(count("data-nession-gallery-link"), 1);
    assert.equal(count("data-nession-source-link"), 1);
    assert.match(html, /<a data-nession-gallery-link href="\.\.\/\.\.\/#\/prototypes"/);
    assert.match(html, /data-np-device/);
    assert.match(html, /np-preview-toolbar/);
    assert.match(html, /np-details/);
    assert.match(html, /prototype-frame-2758\/frame\.css/);
    assert.match(html, /prototype-frame-2758\/frame\.js/);
    assert.doesNotMatch(html, /<iframe\b/i);
    const config = html.match(/<script type="application\/json" id="np-review-config">([\s\S]*?)<\/script>/);
    if (config) {
      const review = JSON.parse(config[1]);
      assert.ok(review.surface.startsWith("#") || review.surface.startsWith("."));
      const element = review.surface.slice(1);
      const match = review.surface.startsWith("#")
        ? html.includes('id="' + element + '"')
        : html.includes('class="' + element + '"');
      assert.ok(match, 'missing embedded product selector ' + review.surface);
      assert.match(html, /prototype-frame-2758\/review-bridge\.js/);
    }
    const readme = readFileSync(join(root, slug, "README.md"), "utf8");
    assert.ok(readme.includes("http"), "scenario must link its Issue or source");
  });
}

test("shared migration assets remain inspectable and dependency-free", () => {
  const bridge = readFileSync(join(root, "prototype-frame-2758", "review-bridge.js"), "utf8");
  assert.match(bridge, /data-np-legacy/);
  assert.match(bridge, /containerType/);
  assert.doesNotMatch(bridge, /\bfetch\s*\(/);
  assert.doesNotMatch(bridge, /iframe|eval\s*\(/i);
});
