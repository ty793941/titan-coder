import type { ApiClient } from '../client.js';

export async function createSession(client: ApiClient, taskId: string, args: Record<string, string>): Promise<unknown> {
  const idempotencyKey = args.idempotencyKey ?? `cli-session-${Date.now()}`;
  return client.request(`/api/tasks/${taskId}/sessions`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      entryAgent: 'project-manager',
      goal: args.goal,
      ...(args.planHash ? { planHash: args.planHash } : {}),
      idempotencyKey,
    }),
  });
}
