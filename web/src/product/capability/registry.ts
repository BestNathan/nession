import type {
  CapabilityContext,
  CapabilityDefinition,
  CapabilityId,
  CapabilitySnapshot,
} from './model';

export interface CapabilityResolutionDiagnostic {
  capabilityId: CapabilityId;
  message: string;
}

export interface CapabilityResolution {
  snapshots: CapabilitySnapshot[];
  diagnostics: CapabilityResolutionDiagnostic[];
}

/**
 * Shared registry for semantic capability providers. Registration order is
 * deterministic, but the registry intentionally owns no UI ordering policy.
 */
export class CapabilityRegistry {
  private readonly definitions = new Map<CapabilityId, CapabilityDefinition>();

  register(definition: CapabilityDefinition): () => void {
    if (this.definitions.has(definition.id)) {
      throw new Error(
        `Capability "${definition.id}" is already registered; use one stable provider per capability id.`,
      );
    }

    this.definitions.set(definition.id, definition);

    return () => {
      if (this.definitions.get(definition.id) === definition) {
        this.definitions.delete(definition.id);
      }
    };
  }

  registerMany(definitions: readonly CapabilityDefinition[]): void {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  has(id: CapabilityId): boolean {
    return this.definitions.has(id);
  }

  listIds(): CapabilityId[] {
    return [...this.definitions.keys()];
  }

  resolveAll(context: CapabilityContext): CapabilityResolution {
    const snapshots: CapabilitySnapshot[] = [];
    const diagnostics: CapabilityResolutionDiagnostic[] = [];

    for (const definition of this.definitions.values()) {
      try {
        const resolved = definition.resolve(context);
        snapshots.push({
          id: definition.id,
          title: definition.title,
          ...resolved,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        diagnostics.push({
          capabilityId: definition.id,
          message: `Capability "${definition.id}" could not be resolved: ${detail}. Fix the provider or its input context.`,
        });
      }
    }

    return { snapshots, diagnostics };
  }
}
