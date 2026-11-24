export const errorCodes = [
  'VALIDATION_FAILED',
  'RESOURCE_NOT_FOUND',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_STATE_TRANSITION',
  'TASK_PLAN_REQUIRED',
  'PLAN_HASH_STALE',
  'PERMISSION_DENIED',
  'APPROVAL_REQUIRED',
  'TOOL_INPUT_INVALID',
  'TOOL_BLOCKED_BY_HOOK',
  'TOOL_EXECUTION_FAILED',
  'TOOL_TIMEOUT',
  'DAEMON_UNAVAILABLE',
  'WORKSPACE_CONFLICT',
  'CHECKPOINT_NOT_FOUND',
  'RUNTIME_ADAPTER_UNAVAILABLE',
  'EVENT_SEQUENCE_GAP',
  'EXECUTION_LEASE_EXPIRED',
  'CLOUD_SECRET_LEASE_EXPIRED',
  'CLOUD_SECRET_CONSUMED',
  'CLOUD_WORKER_DISCONNECTED',
  'CLOUD_RUNTIME_WAITING_INPUT',
  'HANDOFF_CHECKPOINT_INVALID',
  'HANDOFF_TARGET_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'DomainError';
  }
}
