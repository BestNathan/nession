import { describe, expectTypeOf, it } from 'vitest';
import type {
  TransportGeneration,
  AttachAttemptGeneration,
} from '@/platform/attach/SessionAttachController';

describe('research acceptance T21', () => {
  it('keeps transport and attach-attempt identities distinct at the type level', () => {
    expectTypeOf<TransportGeneration>().not.toEqualTypeOf<AttachAttemptGeneration>();
  });
});
