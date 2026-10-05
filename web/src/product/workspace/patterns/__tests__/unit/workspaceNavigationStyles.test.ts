import { describe, expect, it } from 'vitest';
import {
  workspaceCapabilityEntryClass,
  workspaceCapabilityIndicatorClass,
  workspaceCapabilityIndicatorStateClass,
  workspaceCapabilityLabelBaseClass,
  workspaceCapabilityLabelSizeClass,
  workspaceCapabilityScrollClass,
  workspaceCapabilityStateClass,
} from '@/product/workspace/patterns/workspaceNavigationStyles';

describe('Workspace navigation visual grammar (#1451)', () => {
  it('keeps Workspace chrome on canonical Nession vocabulary', () => {
    const classes = [
      workspaceCapabilityScrollClass,
      workspaceCapabilityEntryClass,
      workspaceCapabilityIndicatorClass,
      workspaceCapabilityLabelBaseClass,
      workspaceCapabilityLabelSizeClass(false),
      workspaceCapabilityLabelSizeClass(true),
    ].join(' ');

    expect(classes).toContain('var(--nession-terminal-capsule-control-gap)');
    expect(classes).toContain('var(--nession-radius-control)');
    expect(classes).toContain('var(--nession-typography-caption-weight)');
    expect(classes).not.toMatch(/var\(--(?!nession-)/);
    expect(classes).not.toMatch(/\b(?:text-sm|text-xs|font-semibold|font-medium|rounded-lg|shadow-md)\b/);
  });

  it('state changes color/availability without creating a second geometry recipe', () => {
    expect(workspaceCapabilityStateClass({ active: true, unavailable: false })).toBe(
      'text-foreground',
    );
    expect(workspaceCapabilityStateClass({ active: false, unavailable: false })).toBe(
      'text-muted-foreground hover:text-foreground',
    );
    expect(workspaceCapabilityStateClass({ active: false, unavailable: true })).toBe(
      'cursor-default text-disabled-foreground',
    );

    for (const active of [true, false]) {
      expect(workspaceCapabilityIndicatorStateClass(active)).toMatch(/^bg-/);
    }
  });
});
