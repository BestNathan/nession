# Terminal Session Unit

This directory is the canonical behavior-oriented owner for the terminal/session reconnect slice used by the Narness Treatment C study.

```text
transport-reconnect   physical WebSocket lifecycle and recovery
visibility-wake      explicit browser wake reconnect
attach               attach state + attach request lifecycle
route-recovery       session-level candidate / relay recovery
runtime-projection   product-facing React projection
```

Stable capability identities and cross-unit dependency metadata are authoritative in `/.ai-native/capabilities.json`.

Files outside this directory may re-export these implementations for compatibility. A compatibility projection is not a second owner.
