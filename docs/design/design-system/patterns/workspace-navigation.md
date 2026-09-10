# WorkspaceNavigation

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [workspace.md](../../workspace.md)

WorkspaceNavigation is the interaction pattern for moving through **contextually relevant Workspace capabilities and resources**.

It is not a permanent tab bar containing every registered tool, and it is not a second application shell.

> Existing contract: `design/contracts/patterns/workspace-navigation.json` ([contracts.md](../contracts.md)). Any executable assumptions that require a permanently visible tool strip should be treated as migration debt and updated separately.

## Purpose

Help users reach the part of the Workspace that is useful to the current work without turning Workspace into a feature lobby.

Navigation should be generated from Workspace context and capability state rather than extension registration alone.

Must not:

- render one permanent slot for every installed extension;
- expose unavailable capabilities as dead/disabled chrome simply to advertise them;
- force Files master/detail chrome onto unrelated capabilities;
- allow an extension to define global Workspace navigation independently of Nession;
- become a second full-height app sidebar by default.

## Product model

Workspace content can include resources, locations, infrastructure context, and extension capabilities.

The capability lifecycle is:

```text
unavailable -> available -> relevant -> active
```

Navigation consequences:

| State | Navigation behavior |
|-------|---------------------|
| `unavailable` | Hidden; no reserved slot |
| `available` | May be discoverable through explicit expansion/search/palette or a quiet Workspace section |
| `relevant` | May gain direct Workspace presence or a promoted entry |
| `active` | May show live state and a stronger entry; may also have Session-level presence |

A capability does not become primary navigation merely because it is active. Current work remains primary.

## Presentation model

Nession owns how the currently useful Workspace set is presented. Acceptable patterns include:

- contextual sections;
- compact switching among a small relevant set;
- an explicit `+` / capability picker;
- search / command palette;
- native navigation stack on App;
- focused entry from an active Session capability;
- location/resource-driven navigation when the Workspace contains multiple physical contexts.

The implementation may combine these patterns. No one widget is the product model.

## Capability contribution

Conceptually, a capability contributes semantic data:

```ts
interface WorkspaceCapability {
  id: string
  state: (context: WorkspaceContext) => CapabilityState
  summary?: (context: WorkspaceContext) => CapabilitySummary
  actions?: (context: WorkspaceContext) => CapabilityAction[]
  view?: unknown
}
```

The exact API is implementation-specific.

Important boundary:

> Extensions contribute capability. Nession decides whether, where, and how that capability is navigated.

Do not let a plugin select its own permanent tab position, accent color, or global navigation structure as part of the extension contract.

## Workspace root

The Workspace root should communicate the work context before it communicates the tool catalog.

Depending on context it may surface:

```text
Workspace
├── resources / files
├── repository state
├── active or relevant capabilities
├── Workspace Locations
└── infrastructure/context details on demand
```

A Workspace with only Files should not look like a five-tool product with four missing buttons. A Workspace with Git and an active coding agent may surface those because the work context justifies them.

## Web

Web may use compact tabs/segments when the relevant set is small and stable **for the current context**, but the control should not imply a global closed tool enum.

For larger or more dynamic sets, prefer contextual sections, search, overflow/palette, or explicit drill-down.

A persistent full-width inner sidebar remains a non-default pattern because it competes with the work surface.

## App

App should prefer native spatial and push/pop interaction:

- Workspace opens as contextual depth from the active Session;
- the Workspace root presents what is relevant now;
- tapping an item/capability pushes or overlays deeper detail;
- system/back navigation returns through capability detail before leaving Workspace;
- nested navigation must not fight the top-level `Sessions ← Terminal → Workspace` spatial model.

## Files and other capability-specific layouts

Files may use master/detail on Web and push navigation on App. That composition belongs to Files.

Claude Code may use state/history/configuration views. Git may use repository status and change navigation. Agent/location detail may use an information surface.

WorkspaceNavigation coordinates access; it does not force these capabilities into the same content layout.

## Visual contract

- Navigation chrome is secondary to active Workspace content and substantially secondary to Terminal when the user returns to the Session.
- The visible set should be small enough to remain comprehensible; overflow is preferable to crowding.
- Whitespace and hierarchy are preferred over card/tab proliferation.
- Per-capability branding must not fragment Nession's visual language.
- Active/relevant state may affect presence, but routine availability should remain quiet.

## Anti-patterns

- `Files | Session | Agent | Git | Claude | Docker | K8s | ...` as an indefinitely growing permanent strip.
- Disabled entries for capabilities that cannot work in the current environment.
- One extension = one global tab.
- A Workspace home page that is mostly a grid of feature launch cards.
- A full-height secondary sidebar that exists only to list capabilities.
- Tool-specific accent colors used as navigation identity.
- Hard-coded closed enums that require shell changes for every extension.

## Migration from the current implementation

The current Session-first UI introduced a registry-driven Workspace tool bar/list for Files, Session, Agent, and extension tools. The registry remains useful, but the product semantics change:

```text
old: registered -> permanent navigation presence
new: registered -> capability -> contextual state -> Nession chooses presence
```

Existing components should migrate incrementally. Do not remove reliable capability views merely to satisfy a document; first separate capability contribution from navigation placement, then converge the shell.

## Acceptance for future implementation work

- [ ] Unavailable capabilities do not reserve permanent chrome.
- [ ] Capability registration is separate from navigation placement.
- [ ] Workspace root communicates context, not a global feature catalog.
- [ ] Extensions cannot independently fragment the global navigation model.
- [ ] Web/App may present the same capability differently while preserving semantic state.
- [ ] Files-specific layout remains local to Files.
- [ ] The visible capability set can grow without forcing the shell to grow proportionally.
