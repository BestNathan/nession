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

**Files.** These carry the adaptation in their own header:

| Path | Adapted from |
|---|---|
| `web/src/shared/markdown/runtime/render.tsx` | DeepSeek Harness `render.tsx`, simplified |
| `web/src/shared/markdown/runtime/MarkdownText.tsx` | DeepSeek Harness `MarkdownText.tsx`, simplified |
| `web/src/shared/markdown/ChatMarkdown.module.css` | DeepSeek Harness `MarkdownText.module.css` |

The rest of `web/src/shared/markdown/runtime/` is Nession's own code written
against that runtime's design; it depends on `micromark` and `mdast-util-*` as
declared npm packages rather than vendoring DeepSeek source.

**Adaptation.** Pruned to the Chat profile: single-dollar inline math is off so
a `$HOME` in prose is not a formula; `\(...\)`, `\[...\]` and `$$` delimiters
are on; CJK-friendly strong emphasis; local image syntax recovery. Styling is
Nession's — the upstream palette, typography scale and radius tokens are not
adopted.
