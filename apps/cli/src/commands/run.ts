import type { ApiClient } from '../client.js';

export async function getRun(client: ApiClient, runId: string): Promise<unknown> {
  return client.request(`/api/runs/${runId}`);
}

export async function getRunEvents(client: ApiClient, runId: string, lastEventId?: string): Promise<unknown[]> {
  const events = await client.stream(`/api/runs/${runId}/events`, lastEventId);
  return events.map(event => {
    try {
      const payload = JSON.parse(event.data) as Record<string, unknown>;
      return { ...payload, ...(event.id ? { eventId: event.id } : {}), ...(event.event ? { eventType: event.event } : {}) };
    } catch {
      return event;
    }
  });
}
