export type ApiError = { code: string; message: string; traceId?: string };

export type SseEvent = {
  id?: string;
  event?: string;
  data: string;
};

export class ApiClient {
  constructor(private readonly baseUrl = process.env.TITAN_API_URL ?? 'http://127.0.0.1:3000') {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = response.status === 204 ? '' : await response.text();
    let body: T | ApiError | undefined;
    try {
      body = text ? JSON.parse(text) as T | ApiError : undefined;
    } catch {
      body = { code: 'INVALID_RESPONSE', message: 'API returned invalid JSON' };
    }
    if (!response.ok) throw body as ApiError;
    return body as T;
  }

  async stream(path: string, lastEventId?: string): Promise<SseEvent[]> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        accept: 'text/event-stream',
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      try {
        throw await Promise.resolve(JSON.parse(text) as ApiError);
      } catch (error) {
        throw error;
      }
    }
    return text.split(/\n\n+/).map(parseSseBlock).filter((event): event is SseEvent => event !== undefined);
  }
}

function parseSseBlock(block: string): SseEvent | undefined {
  const lines = block.split('\n');
  const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data) return undefined;
  const id = lines.find(line => line.startsWith('id:'))?.slice(3).trim();
  const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
  return { ...(id ? { id } : {}), ...(event ? { event } : {}), data };
}
