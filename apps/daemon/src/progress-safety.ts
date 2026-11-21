import type { ExecutionCheckpoint, RunProgress } from '@titan/daemon-protocol';

const types = new Set(['running', 'output', 'checkpoint', 'completed', 'failed', 'cancelled', 'waiting_input']);
const payloadFields = new Set(['text', 'code', 'message', 'reason', 'status', 'turn', 'toolCallId', 'toolName', 'reference', 'evidence', 'usage', 'output', 'result', 'error', 'checkpointId', 'exitCode', 'signal', 'source', 'pid']);
const sensitiveField = /(?:api.?key|secret|password|authorization|token|credential|environment|^env$)/i;

export function sanitizeProgress(input: RunProgress, secrets: readonly string[] = []): RunProgress {
  if (!input || !types.has(input.type) || typeof input.eventId !== 'string' || !input.eventId || input.eventId.length > 200 ||
      !Number.isSafeInteger(input.sequence) || input.sequence < 1 || typeof input.claimToken !== 'string' || !input.claimToken ||
      !input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new Error('INVALID_PROGRESS');
  const redact = (text: string): string => {
    let safe = text;
    for (const secret of secrets) if (secret) safe = safe.split(secret).join('[REDACTED]');
    return safe.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*[^\s,"'}]+)/gi, '[REDACTED]');
  };
  const clean = (value: unknown, depth = 0): unknown => {
    if (depth > 20) throw new Error('PROGRESS_TOO_DEEP');
    if (typeof value === 'string') return redact(value);
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
    if (typeof value === 'object' && value) return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !sensitiveField.test(key) && key !== '__proto__' && key !== 'constructor' && key !== 'prototype')
      .map(([key, item]) => [key, clean(item, depth + 1)]));
    return null;
  };
  const progress: RunProgress = {
    eventId: input.eventId, sequence: input.sequence, claimToken: input.claimToken, type: input.type,
    payload: Object.fromEntries(Object.entries(input.payload).filter(([key]) => payloadFields.has(key)).map(([key, value]) => [key, clean(value)])),
  };
  if (input.checkpoint) {
    const checkpoint = input.checkpoint;
    if (typeof checkpoint.id !== 'string' || !Array.isArray(checkpoint.messages) || !Array.isArray(checkpoint.successfulTools) || !Array.isArray(checkpoint.evidence)) throw new Error('INVALID_CHECKPOINT');
    progress.checkpoint = {
      id: redact(checkpoint.id),
      messages: checkpoint.messages.map(message => {
        if (!message || !['user', 'assistant', 'tool'].includes(message.role) || typeof message.text !== 'string') throw new Error('INVALID_CHECKPOINT');
        return { role: message.role, text: redact(message.text) };
      }),
      successfulTools: checkpoint.successfulTools.map(tool => {
        if (!tool || typeof tool.id !== 'string' || typeof tool.name !== 'string' || typeof tool.inputHash !== 'string') throw new Error('INVALID_CHECKPOINT');
        return { id: redact(tool.id), name: redact(tool.name), inputHash: redact(tool.inputHash), output: clean(tool.output) };
      }),
      evidence: checkpoint.evidence.map(item => {
        if (!item || typeof item.kind !== 'string' || typeof item.reference !== 'string') throw new Error('INVALID_CHECKPOINT');
        return { kind: redact(item.kind), reference: redact(item.reference) };
      }),
    } satisfies ExecutionCheckpoint;
  }
  if (Buffer.byteLength(JSON.stringify(progress)) > 1024 * 1024) throw new Error('PROGRESS_TOO_LARGE');
  return progress;
}
