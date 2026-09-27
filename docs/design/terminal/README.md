# Terminal platform requirements (#1094–#1096)

Upstream: [`VISION.md`](../../../VISION.md) → [`PRINCIPLE.md`](../../../PRINCIPLE.md) → [Terminal Surface](../design-system/patterns/terminal-surface.md).

GitHub requirements (Approved):

| Issue | Topic | Canonical design |
|-------|--------|------------------|
| [#1096](https://github.com/BestNathan/nession/issues/1096) | PTY-faithful Web/App interaction & TUI compatibility | [interaction-semantics.md](interaction-semantics.md) |
| [#1095](https://github.com/BestNathan/nession/issues/1095) | Multi-client Controller / Observer | [multi-client-ownership.md](multi-client-ownership.md) |
| [#1094](https://github.com/BestNathan/nession/issues/1094) | Terminal stream, checkpoints & replay | [stream-replay.md](stream-replay.md) |

Related: [#321](https://github.com/BestNathan/nession/issues/321) (live scrollback/bootstrap), [#1081](https://github.com/BestNathan/nession/issues/1081) (App shell gestures).

## Dependency graph

```text
#321 scrollback/bootstrap (existing)
        │
        ▼
#1096 PTY semantics ──► one encoder/router; no app-specific branches
        │
        ├──────────────────┐
        ▼                  ▼
#1095 control lease    #1094 stream + replay
(observer resize)      (ordered output+resize; read-only replay)
        │                  │
        └────────┬─────────┘
                 ▼
     Observer replay while live continues (#1095 + #1094)
```

**Implementation order**

1. **#1096** — Shared `TerminalInteractionController`; remove Ctrl+D hijack; semantic keys/paste/mouse; deterministic TUI fixture. No protocol change required for v1.
2. **#1095** — Session-scoped control generation; agent rejects stale input/resize; Web/App Controller/Observer UX. Resize authority builds on #1096’s single-controller path.
3. **#1094** — New terminal Protocol Units (stream cursor, checkpoint, replay range); agent retention; Web resume/gap + separate replay instance. Uses ordered resize from #1096 and observer model from #1095.

**Ship rule:** Do not close #1094–#1096 until each issue’s Success Criteria checkboxes are satisfied in code/tests; design docs here are upstream constraints, not completion.
