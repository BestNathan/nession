/** Parse attach / control wire payloads until codegen includes optional fields. */
export function readAttachControlFields(payload: unknown): {
  controlGeneration?: number;
  controlRole?: 'controller' | 'observer';
  controllerClientId?: string;
  streamEpoch?: number;
  streamCursor?: number;
  inputEpoch?: number;
  inputAppliedThrough?: number;
} {
  if (!payload || typeof payload !== 'object') {
    return {};
  }
  const p = payload as Record<string, unknown>;
  const role =
    p.control_role === 'observer'
      ? 'observer'
      : p.control_role === 'controller'
        ? 'controller'
        : undefined;
  return {
    controlGeneration:
      typeof p.control_generation === 'number' ? p.control_generation : undefined,
    controlRole: role,
    controllerClientId:
      typeof p.controller_client_id === 'string' ? p.controller_client_id : undefined,
    streamEpoch: typeof p.stream_epoch === 'number' ? p.stream_epoch : undefined,
    streamCursor: typeof p.stream_cursor === 'number' ? p.stream_cursor : undefined,
    // Absent, never zero: an agent built before the input contract states
    // neither field, and "I have no position" is a different answer from "my
    // position is zero" — the first is why a client keeps sending unsequenced
    // input rather than numbering against a cursor nobody holds (#1307).
    inputEpoch: typeof p.input_epoch === 'number' ? p.input_epoch : undefined,
    inputAppliedThrough:
      typeof p.input_applied_through === 'number' ? p.input_applied_through : undefined,
  };
}

export function readControlAcquireReply(payload: unknown): {
  generation?: number;
  role?: 'controller' | 'observer';
  controllerClientId?: string;
} {
  if (!payload || typeof payload !== 'object') {
    return {};
  }
  const p = payload as Record<string, unknown>;
  const role =
    p.role === 'observer'
      ? 'observer'
      : p.role === 'controller'
        ? 'controller'
        : undefined;
  return {
    generation: typeof p.generation === 'number' ? p.generation : undefined,
    role,
    controllerClientId:
      typeof p.controller_client_id === 'string' ? p.controller_client_id : undefined,
  };
}

export function readControlChanged(payload: unknown): {
  sessionName: string;
  generation: number;
  controllerClientId?: string;
} | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.session_name !== 'string' || typeof p.generation !== 'number') {
    return null;
  }
  return {
    sessionName: p.session_name,
    generation: p.generation,
    controllerClientId:
      typeof p.controller_client_id === 'string' ? p.controller_client_id : undefined,
  };
}
