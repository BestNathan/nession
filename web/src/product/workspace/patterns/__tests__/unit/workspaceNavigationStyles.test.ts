import { describe, expect, it } from 'vitest';
import {
  workspaceCapabilityEntryClass,
  workspaceCapabilityEntryLayoutClass,
  workspaceCapabilityIndicatorClass,
  workspaceCapabilityIndicatorStateClass,
  workspaceCapabilityLabelAlignmentClass,
  workspaceCapabilityLabelBaseClass,
  workspaceCapabilityLabelSizeClass,
  workspaceCapabilityScrollClass,
  workspaceCapabilityStateClass,
} from '@/product/workspace/patterns/workspaceNavigationStyles';

describe('Workspace navigation visual grammar (#1451 / #1455)', () => {
  it('keeps Workspace chrome on canonical Nession vocabulary', () => {
    const classes = [
      workspaceCapabilityScrollClass,
      workspaceCapabilityEntryClass,
      workspaceCapabilityIndicatorClass,
      workspaceCapabilityLabelBaseClass,
      workspaceCapabilityLabelSizeClass,
    ].join(' ');

    expect(classes).toContain('var(--nession-terminal-capsule-control-gap)');
    expect(classes).toContain('var(--nession-radius-control)');
    expect(classes).toContain('var(--nession-typography-caption-weight)');
    expect(classes).not.toMatch(/var\(--(?!nession-)/);
    expect(classes).not.toMatch(/\b(?:text-sm|text-xs|font-semibold|font-medium|rounded-lg|shadow-md)\b/);
  });

  it('pins every capability entry to the Conversation control band', () => {
    expect(workspaceCapabilityEntryClass).toContain(
      'h-[length:var(--nession-control-md)]',
    );
    expect(workspaceCapabilityEntryClass).toContain(
      'w-[length:var(--nession-terminal-capsule-capability-slot-width)]',
    );
    expect(workspaceCapabilityEntryClass).not.toContain('min-h-');
    expect(workspaceCapabilityLabelBaseClass).toContain('truncate');
    expect(workspaceCapabilityLabelBaseClass).toContain('whitespace-nowrap');
  });

  it('expresses Web/App composition as an intentional variant without changing geometry', () => {
    expect(workspaceCapabilityEntryLayoutClass('web')).toBe('flex-row');
    expect(workspaceCapabilityEntryLayoutClass('app')).toBe('flex-col');
    expect(workspaceCapabilityLabelAlignmentClass('web')).toBe('text-left');
    expect(workspaceCapabilityLabelAlignmentClass('app')).toBe('text-center');
  });

  it('state changes emphasis without creating a second geometry recipe', () => {
    expect(workspaceCapabilityStateClass({ active: true })).toBe('text-foreground');
    expect(workspaceCapabilityStateClass({ active: false })).toBe(
      'text-muted-foreground hover:text-foreground',
    );

    for (const active of [true, false]) {
      expect(workspaceCapabilityIndicatorStateClass(active)).toMatch(/^bg-/);
    }
  });
});
