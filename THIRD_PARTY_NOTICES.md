# Third-party notices

This file records third-party source that has been **copied or substantially
adapted** into Nession, beyond what the package manager already records. A
dependency declared in `Cargo.toml`, `web/package.json` or a lockfile is
licence-tracked by that file and does not belong here; a file whose body came
from somewhere else does.

## The convention

Every adopted file carries a header naming where it came from:

```text
Upstream: <repository>
Baseline: <commit>
Source: <path>
License: MIT
Adaptation: <what changed for Nession>
```

The **baseline commit is pinned, not "latest"**. An adaptation that says
"upstream: main" cannot be re-checked later: the file it was copied from will
have moved, and a reviewer cannot tell an intentional divergence from drift.

This file is the register; the per-file header is the local statement. A file
listed here without a header is a defect, and so is a header whose file is not
listed — `docs/superpowers/plans/2026-10-01-ai-conversation-framework.md`
records the requirement (#1363 SC-16) that asks for both.

## Design baselines that were read, not copied

Requirement #1363 asks for its conversation UI to adopt the structure,
information density and interaction semantics of two upstream chat
implementations rather than to redesign something similar. Both were read at a
pinned commit, and the readings are recorded in
[`docs/superpowers/plans/2026-10-01-ai-conversation-upstream-port.md`](docs/superpowers/plans/2026-10-01-ai-conversation-upstream-port.md).

| Upstream | Baseline | Read for |
|---|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | `6d7d81fb569ea3413b26f41cc4522252840dcd18` | grouping rules, the reserved disclosure row, hover/focus reveal, the touch fallbacks |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | `21638c56315ae6a2b552d6091945d3144c9af32e` | the turn → process → tool model, the density values, the scroll and anchor protocols |

**No upstream source was copied into Nession for this work, so no additional
notice is owed for it.** The shared conversation components under
`web/src/shared/ai-conversation/` are Nession's own code, written against those
contracts: the numbers in the port document, the six/ twelve/ sixteen-pixel
rhythm, the zero-height hidden row, the opacity-only reveal, and the
focus-preserving collapse. Where an upstream mechanism was not portable it
was translated rather than transcribed — OpenClaw's chat is Lit, so its
state/layout/interaction contracts were re-expressed in React, which the
requirement anticipated.

This section exists so the baselines are re-checkable and so the distinction
between *read* and *copied* is on the record. If a future change does port
upstream source directly, it belongs in the section below, with a per-file
header, and not here.

## DeepSeek Harness — incremental Markdown runtime

Adopted by #1184 as the Chat Markdown path, and listed here retroactively: the
files carried an in-source "adapted from DeepSeek Harness" note but no commit or
licence record, so the repository had provenance statements that could not be
re-checked.

- **Upstream:** https://github.com/deepseek-ai/deepseek-harness
- **Baseline:** `21638c56315ae6a2b552d6091945d3144c9af32e` (2026-09-27)
- **License:** MIT
- **Copyright:** Copyright (c) 2026 DeepSeek

**Files.** Every file below is upstream source at the pinned baseline, copied
or substantially adapted, and each carries the matching header:

| Path | Upstream source | What changed |
|---|---|---|
| `web/src/shared/markdown/runtime/parser.ts` | `markdown/parse.ts` | grammar options for the Chat dialect (below) |
| `web/src/shared/markdown/runtime/incremental.ts` | `markdown/incremental.ts` | re-formatting only |
| `web/src/shared/markdown/runtime/cjkFriendlyStrong.ts` | `markdown/cjkFriendlyStrong.ts` | re-formatting only |
| `web/src/shared/markdown/runtime/mathCompatibility.ts` | `markdown/mathCompatibility.ts` | re-formatting only |
| `web/src/shared/markdown/runtime/local-image-syntax.ts` | `markdown/local-image-syntax.ts` | simplified; no `dsh-app://` vocabulary |
| `web/src/shared/markdown/runtime/katex.tsx` | `markdown/katex.tsx` | error span uses a Nession token |
| `web/src/shared/markdown/runtime/render.tsx` | `markdown/render.tsx` | simplified; Nession product semantics (links, images, tables, footnotes) |
| `web/src/shared/markdown/runtime/MarkdownText.tsx` | `markdown/MarkdownText.tsx` | simplified; Nession styling and lifecycle wiring |
| `web/src/shared/markdown/ChatMarkdown.module.css` | `markdown/MarkdownText.module.css` | Nession design tokens |

It is a *copy*, not a dependency: the file is in this repository and the
package manager records nothing for it. The one file under
`web/src/shared/markdown/runtime/` that is **not** upstream's is
`ChatCodeBlock.tsx`, which is Nession's own highlight.js code block; the
runtime depends on `micromark`, `mdast-util-*`, `katex` and `highlight.js` as
declared npm packages.

**Adaptation.** Pruned to the Chat profile: single-dollar text math is off so
`$HOME`, `$PATH`, `$100 ... $200` and `echo "$VAR"` in prose are not formulae
(`\(...\)`, `\[...\]` and `$$` delimiters are on); GFM's optional single-tilde
strikethrough is off so `~/.claude`, `~10ms` and `60~70%` stay prose and only
`~~explicit~~` strikes through; CJK-friendly strong emphasis; local image
syntax recovery. Styling is Nession's — the upstream palette, typography scale
and radius tokens are not adopted, and upstream's file-mention, image-preview
and link-glyph UI is not ported.

**License text.** As the MIT terms require:

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
