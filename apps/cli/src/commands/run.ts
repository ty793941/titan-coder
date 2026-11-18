import type { ApiClient } from '../client.js';

export async function getRun(client: ApiClient, runId: string): Promise<unknown> {
  return client.request(`/api/runs/${runId}`);
}
