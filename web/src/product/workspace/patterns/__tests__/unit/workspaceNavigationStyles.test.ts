import { describe, expect, it } from 'vitest';
import {
  workspaceCapabilityEntryClass,
  workspaceCapabilityEntryLayoutClass,
  workspaceCapabilityLabelAlignmentClass,
  workspaceCapabilityLabelBaseClass,
  workspaceCapabilityLabelSizeClass,
  workspaceCapabilityScrollClass,
  workspaceCapabilityStateClass,
} from '@/product/workspace/patterns/workspaceNavigationStyles';

describe('Workspace navigation visual grammar (#1451 / #1455 / #1458)', () => {
  it('keeps Workspace chrome on canonical Nession vocabulary', () => {
    const classes = [
      workspaceCapabilityScrollClass,
      workspaceCapabilityEntryClass,
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
    expect(workspaceCapabilityStateClass({ active: true })).toBe(
      'bg-accent text-accent-foreground',
    );
    expect(workspaceCapabilityStateClass({ active: false })).toBe(
      'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
    );

    // Selected state belongs to the entry surface itself. There is no detached
    // indicator recipe that can be confused with work/pagination/status.
    expect(workspaceCapabilityStateClass({ active: true })).not.toContain('font-');
    expect(workspaceCapabilityStateClass({ active: false })).not.toContain('font-');
  });
});
