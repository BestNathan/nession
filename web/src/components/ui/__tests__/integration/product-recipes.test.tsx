import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  DetailEmpty,
  DetailFact,
  DetailFacts,
  DetailHeader,
  DetailSection,
  DetailSurface,
} from '@/components/ui/resource-detail';
import {
  FormActions,
  FormField,
  FormRow,
  FormSection,
  FormSurface,
} from '@/components/ui/configuration-form';
import {
  OperationActions,
  OperationError,
  OperationLead,
} from '@/components/ui/operation-surface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

describe('shared content-region recipes (#3137)', () => {
  it('ResourceDetail emits one anatomy and never gives a fact input chrome', () => {
    const { container } = render(
      <DetailSurface data-testid="surface">
        <DetailHeader
          eyebrow="Project"
          title="Nession"
          titleTestId="title"
          badges={<span>badge</span>}
          meta="project-id"
          description="A declaration"
          actions={<button type="button">settings</button>}
        >
          <button type="button">New Session</button>
        </DetailHeader>
        <DetailSection title="Git source">
          <DetailFacts>
            <DetailFact label="Ref" mono inline valueTestId="ref">
              main
            </DetailFact>
          </DetailFacts>
          <DetailEmpty>No source configured.</DetailEmpty>
        </DetailSection>
      </DetailSurface>,
    );

    expect(screen.getByTestId('surface')).toHaveAttribute('data-recipe', 'resource-detail');
    expect(screen.getByTestId('title')).toHaveAttribute('data-recipe-part', 'detail-title');
    expect(screen.getByText('Project')).toHaveAttribute('data-recipe-part', 'detail-eyebrow');
    expect(screen.getByText('A declaration')).toHaveAttribute(
      'data-recipe-part',
      'detail-description',
    );
    expect(screen.getByText('Git source')).toHaveAttribute(
      'data-recipe-part',
      'detail-section-title',
    );
    expect(screen.getByText('Ref')).toHaveAttribute('data-recipe-part', 'detail-fact-label');
    expect(screen.getByTestId('ref')).toHaveAttribute('data-recipe-part', 'detail-fact-value');
    expect(screen.getByText('No source configured.')).toHaveAttribute(
      'data-recipe-part',
      'detail-empty',
    );

    // Corresponding roles come from the shared typography vocabulary.
    expect(screen.getByTestId('title').className).toContain(
      '--nession-typography-title-size',
    );
    expect(screen.getByText('Git source').className).toContain(
      '--nession-typography-secondary-size',
    );
    expect(screen.getByText('Ref').className).toContain(
      '--nession-typography-caption-size',
    );
    expect(screen.getByTestId('ref').className).toContain(
      '--nession-typography-code-size',
    );

    // A read-only fact is not a disabled control, a fieldset or an input box.
    expect(container.querySelector('input, textarea, select, fieldset')).toBeNull();
  });

  it('ConfigurationForm owns the label/help/error and repeated-row relationship', () => {
    render(
      <FormSurface data-testid="form">
        <FormSection title="Identity" description="Required">
          <FormField
            id="name"
            label="Name"
            description="Shown in navigation."
            error="Name is required."
            errorTestId="name-error"
          >
            <Input id="name" aria-invalid />
          </FormField>
        </FormSection>
        <FormRow data-testid="row">row</FormRow>
        <FormActions>
          <Button type="button" variant="outline">
            Cancel
          </Button>
          <Button type="button">Save</Button>
        </FormActions>
      </FormSurface>,
    );

    expect(screen.getByTestId('form')).toHaveAttribute(
      'data-recipe',
      'configuration-form',
    );
    expect(screen.getByLabelText('Name')).toHaveAttribute('id', 'name');
    expect(screen.getByText('Identity')).toHaveAttribute(
      'data-recipe-part',
      'form-section-title',
    );
    expect(screen.getByText('Shown in navigation.')).toHaveAttribute(
      'data-recipe-part',
      'form-help',
    );
    expect(screen.getByTestId('name-error')).toHaveAttribute(
      'data-recipe-part',
      'form-error',
    );
    expect(screen.getByTestId('name-error')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('row').className).toContain('bg-muted/40');
    expect(screen.getByText('Cancel').parentElement).toHaveAttribute(
      'data-recipe-part',
      'form-actions',
    );
  });

  it('OperationSurface owns the lead, action line and surface-level error', () => {
    render(
      <>
        <OperationLead>This creates a new Session.</OperationLead>
        <OperationError testId="action-error">The server refused the operation.</OperationError>
        <OperationActions data-testid="actions">
          <Button type="button" variant="outline">
            Cancel
          </Button>
          <Button type="button">Create</Button>
        </OperationActions>
      </>,
    );

    expect(screen.getByText('This creates a new Session.')).toHaveAttribute(
      'data-recipe-part',
      'operation-lead',
    );
    expect(screen.getByTestId('action-error')).toHaveAttribute(
      'data-recipe-part',
      'operation-error',
    );
    expect(screen.getByTestId('action-error')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('actions')).toHaveAttribute(
      'data-recipe-part',
      'operation-actions',
    );
  });

});
