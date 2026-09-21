import { describe, expect, it } from 'vitest';
import type {
  TransportGeneration,
  AttachAttemptGeneration,
} from '@/platform/attach/SessionAttachController';

type IsAssignable<A, B> = [A] extends [B] ? true : false;
type AssertFalse<T extends false> = T;

const transportIsNotAttach: AssertFalse<
  IsAssignable<TransportGeneration, AttachAttemptGeneration>
> = false;

const attachIsNotTransport: AssertFalse<
  IsAssignable<AttachAttemptGeneration, TransportGeneration>
> = false;

describe('research acceptance T21', () => {
  it('keeps transport and attach-attempt identities distinct at the type level', () => {
    expect(transportIsNotAttach).toBe(false);
    expect(attachIsNotTransport).toBe(false);
  });
});
