# Design Spec: Terminal Session State — Jotai Atomic Refactor

## Overview

Replace scattered `useState` + prop-drilling + callback chains in the terminal attach/session flow with Jotai atoms. Each piece of state becomes an independent atom; components subscribe to only what they need. This eliminates the 4-layer callback chain for session switching, removes 2 hooks (`useAttachFlow`, `useP2PWithFallback`), and makes the data flow explicit and unidirectional.

## Architecture

```
atoms/terminal.ts                    ← NEW: all terminal session atoms
  ├─ Base atoms                      独立语义单元，各自有独立的更新频率和订阅边界
  ├─ Derived atoms                   纯计算，从 base atoms 派生
  └─ Action atoms                    写操作封装，保证多 atom 写入的一致性

Components (modified):
  Dashboard.tsx                     删 useAttachFlow，读 hasActiveSessionAtom
  TerminalView.tsx                   删 useP2PWithFallback，读 derived atoms
  Terminal.tsx                       删 props，直接读 p2pStateAtom / sessionNameAtom
  SessionDropdown.tsx                删 onSwitchSession prop，用 attachToSessionAtom
  AddressSelector.tsx                删 setManualOverride prop，用 switchAddressAtom
  AttachDialog.tsx                   删本地 attachInfo state，用 attachInfoAtom

Hooks (modified):
  useP2PConnection.ts                暴露 setter 让 ws.onopen 写入 p2pStateAtom

Deleted:
  useAttachFlow.ts                  逻辑迁移到 action atoms
  useP2PWithFallback.ts             逻辑迁移到 derived atoms
```

## 5 Design Rules

These govern every decision about what becomes an atom and what doesn't:

| # | Rule | Application |
|---|------|-------------|
| 1 | Atom represents a **semantic state unit**, not a component | `sessionIdAtom`, not `terminalPageAtom` |
| 2 | Split atoms according to **independent update frequency** and **dependency boundaries** | `sessionId` never changes during a session; `manualOverride` changes on every address switch — separate atoms |
| 3 | **Derived values must be atoms**, not duplicated local computations | `activeUrl`, `effectiveMode`, `isSwitching` are derived atoms, not `useMemo` in components |
| 4 | Components **consume** atoms; business mutations should be **action atoms** | `attachToSessionAtom` writes 7 base atoms atomically; `switchAddressAtom` writes 1 |
| 5 | Don't create atoms merely to make components smaller. Create atoms when the state has an **independent semantic, lifecycle, dependency, or subscription boundary** | `p2pConnectionAtom` holds the stable connection object; `p2pStateAtom` is separate because its lifecycle is driven by WebSocket events |

## Atom Inventory

### Base Atoms (writable, independent)

```ts
// ── Session identity (一起写入，但各自独立订阅) ──
sessionIdAtom:     string                       // "k8s-agent:1"
sessionNameAtom:   string                       // "1"

// ── Server attach response (一起写入) ──
attachInfoAtom:    AttachInfo | null            // 地址列表 + connection_token
orderedUrlsAtom:   string[]                     // 延迟排序后的候选 URL

// ── User preferences (各自独立变) ──
rendererAtom:      'webgl' | 'canvas'           // renderer 偏好
envRefsAtom:       EnvFileRef[]                 // 选中的 env 文件

// ── Address selection (AddressSelector + fallback driver 写入) ──
manualOverrideAtom: string | null               // 用户手动选的地址
forcedRelayAtom:    boolean                     // 所有 P2P 地址都失败后置 true

// ── Connection state (useP2PConnection 内部写入) ──
p2pStateAtom:       ConnectionState             // ws.onopen → 'connected', etc.
p2pConnectionAtom:  P2PConnection | null        // 稳定引用的连接对象
```

### Derived Atoms (read-only, computed)

```ts
activeUrlAtom:     string | null   // = manualOverride ?? orderedUrls[0] ?? null; null if forcedRelay
effectiveModeAtom: 'p2p' | 'relay' // = forcedRelay ? 'relay' : attachInfo.mode
isSwitchingAtom:   boolean         // = manualOverride !== null && p2pState !== 'connected'
hasActiveSessionAtom: boolean      // = !!sessionId
sessionIdFromUrlAtom: string | null // parsed from location.pathname (for deep-link restore)
```

### Action Atoms (write, atomic)

```ts
attachToSessionAtom     // writes: sessionId, sessionName, attachInfo, orderedUrls,
                        //         renderer, envRefs, manualOverride, forcedRelay=false
                        // + navigates to /terminal/:sessionId

disconnectAtom          // clears all session atoms, navigates to /

switchAddressAtom       // writes: manualOverride

requestAttachAtom       // sends client.session.attach via wsService,
                        // writes attachInfoAtom with response
```

## Data Flow

### Flow 1: Dashboard → Attach → Terminal

```
SessionList click
  → AttachDialog opens
    → requestAttachAtom(session, mode)        // 发 client.session.attach
      → server responds
        → set(attachInfoAtom, response)
    → user picks route + renderer
    → Confirm
      → attachToSessionAtom(session, choice)  // 一次写入 7 个 atom
        → navigate('/terminal/k8s-agent%3A1')

Dashboard 读到 hasActiveSessionAtom === true
  → 渲染 TerminalView（不再需要 props 传递 AttachedSession）
```

### Flow 2: P2P Connect → client.attach

```
useP2PConnection 建 WebSocket
  → ws.onopen
    → setP2pState('connected')
    → setP2pConnection(connection)   // 稳定引用

Terminal.tsx 订阅 p2pStateAtom
  → useEffect: p2pState === 'connected' && prev !== 'connected'
    → view.reattach()
      → ConnectionManager.reattach()
        → p2pAttachSent = false
        → attach() → attachP2P()
          → waitForConnection()（已 connected，立即 resolve）
          → sendMessage({ msg_type: "client.attach", session_name })
```

### Flow 3: Address Switch（route 切换）

```
AddressSelector 点另一个地址
  → switchAddressAtom("ws://10.0.0.1:19090/ws")
    → set(manualOverrideAtom, "ws://10.0.0.1:19090/ws")

useP2PConnection 检测到 activeUrlAtom 变化
  → 关旧 socket → 建新 socket
    → ws.onopen → setP2pState('connected')
      → Terminal.tsx effect → view.reattach()
```

### Flow 4: Session Switch（terminal 内切 session）

```
SessionDropdown 选另一个 session
  → AttachDialog opens（和 Flow 1 一样）
  → requestAttachAtom(newSession, mode)
  → Confirm → attachToSessionAtom(newSession, choice)
    → navigate('/terminal/new-session-id')

Dashboard 检测 key 变化 → 卸载旧 TerminalView → 挂载新 TerminalView
  → useP2PConnection 建新 socket
    → ws.onopen → setP2pState('connected')
      → Terminal.tsx effect → client.attach
```

## Component Subscription Map

| Component | Reads | Writes |
|-----------|-------|--------|
| Dashboard | `hasActiveSessionAtom` | `disconnectAtom`, `attachToSessionAtom` |
| TerminalView | `effectiveModeAtom`, `activeUrlAtom`, `isSwitchingAtom`, `p2pConnectionAtom`, `orderedUrlsAtom` | — |
| Terminal | `p2pStateAtom`, `p2pConnectionAtom`, `sessionNameAtom`, `sessionIdAtom` | — (effect 驱动) |
| SessionDropdown | `sessionIdAtom`, `sessionNameAtom`, sessions list (from query) | `requestAttachAtom`, `attachToSessionAtom` |
| AddressSelector | `activeUrlAtom`, `orderedUrlsAtom`, `manualOverrideAtom`, `isSwitchingAtom` | `switchAddressAtom` |
| AttachDialog | `attachInfoAtom`, env files (from query) | `requestAttachAtom` |

## Protocol Interaction（不变）

消息交互完全不改。`client.session.attach`、`client.attach`、`client.session.relay.begin` 的发送时机和 payload 保持不变。这次重构只改**谁在什么时候调用**，不改消息格式。

## Deleted Code

| File | Reason |
|------|--------|
| `useAttachFlow.ts` | `attachedSession` state → base atoms; `confirmAttach` → `attachToSessionAtom`; `backToDashboard` → `disconnectAtom`; `pendingTerminalSessionId` → `sessionIdFromUrlAtom` |
| `useP2PWithFallback.ts` | `manualOverride`/`forcedRelay` → base atoms; `activeUrl`/`effectiveMode`/`isSwitching` → derived atoms; `P2PFallbackResult` interface no longer needed |
| `AttachedSession` interface (in TerminalView.tsx) | Fields distributed across base atoms; no single object needed |
| Callback props: `onSwitchSession`, `handleBack`, `setManualOverride` | Replaced by action atoms |
| `RenderTerminal.tsx` | Becomes trivial wrapper — may inline into Dashboard |

## Testing

### Unit Tests (new)

- `atoms/__tests__/terminal.test.ts` — derived atom computation, action atom writes
- Existing component tests update mocks from props to atoms

### Integration Tests (modified)

- P2P attach flow tests continue to pass — protocol unchanged
- Session switch flow tests — verify `attachToSessionAtom` clears old state and sets new

### Rust Tests

No changes. This is purely a frontend refactor.

## Rollback Safety

If Jotai integration causes issues in staging, the change can be reverted by restoring the deleted `useAttachFlow.ts` and `useP2PWithFallback.ts` files and reverting component changes. No server-side or protocol changes are involved.
