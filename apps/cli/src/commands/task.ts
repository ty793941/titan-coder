import type { ApiClient } from '../client.js';

export async function createTask(client: ApiClient, args: Record<string, string>): Promise<unknown> {
  return client.request(`/api/projects/${encodeURIComponent(args.project ?? '')}/tasks`, {
    method: 'POST',
    headers: { 'Idempotency-Key': args.idempotencyKey ?? `cli-task-${Date.now()}` },
    body: JSON.stringify({ title: args.title, goal: args.goal, acceptanceCriteria: [args.goal], priority: 'medium' }),
  });
}

export function getTask(client: ApiClient, taskId: string): Promise<unknown> {
  return client.request(`/api/tasks/${encodeURIComponent(taskId)}`);
}
