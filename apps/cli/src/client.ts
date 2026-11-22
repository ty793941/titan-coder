export type ApiError = { code: string; message: string; traceId?: string };

export class ApiHttpError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

export type SseEvent = {
  id?: string;
  event?: string;
  data: string;
};

export class ApiClient {
  constructor(private readonly baseUrl = process.env.TITAN_API_URL ?? 'http://127.0.0.1:3000') {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const daemonToken = path.startsWith('/api/daemons/') && path !== '/api/daemons/register' ? process.env.TITAN_DAEMON_TOKEN : undefined;
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      redirect: 'error',
      headers: { 'content-type': 'application/json', ...(daemonToken ? { authorization: `Bearer ${daemonToken}` } : {}), ...(init.headers ?? {}) },
    });
    const text = response.status === 204 ? '' : await response.text();
    let body: T | undefined;
    try {
      body = text ? JSON.parse(text) as T : undefined;
    } catch {
      throw new ApiHttpError('INVALID_RESPONSE', 'API returned invalid JSON', response.status);
    }
    if (!response.ok) throw responseError(body, response.status);
    return body as T;
  }

  async stream(path: string, lastEventId?: string, signal?: AbortSignal): Promise<SseEvent[]> {
    const events: SseEvent[] = [];
    for await (const event of this.iterate(path, lastEventId, signal)) events.push(event);
    return events;
  }

  async *iterate(path: string, lastEventId?: string, signal?: AbortSignal): AsyncGenerator<SseEvent> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...(signal ? { signal } : {}),
      headers: {
        accept: 'text/event-stream',
        ...(lastEventId !== undefined ? { 'Last-Event-ID': lastEventId } : {}),
      },
    });
    if (!response.ok) {
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new ApiHttpError('INVALID_RESPONSE', 'API returned invalid JSON', response.status);
      }
      throw responseError(body, response.status);
    }
    if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
      await response.body?.cancel();
      throw new ApiHttpError('INVALID_RESPONSE', 'API did not return an event stream', response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const event of parser.push(decoder.decode(value, { stream: true }))) yield event;
      }
      for (const event of parser.push(decoder.decode())) yield event;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

function responseError(body: unknown, status: number): ApiHttpError {
  const error = body as Partial<ApiError> | undefined;
  return new ApiHttpError(error?.code ?? 'HTTP_ERROR', error?.message ?? `HTTP ${status}`, status);
}

class SseParser {
  private line = '';
  private skipLf = false;
  private data: string[] = [];
  private size = 0;
  private id: string | undefined;
  private event: string | undefined;

  push(text: string): SseEvent[] {
    const events: SseEvent[] = [];
    for (const character of text) {
      if (this.skipLf && character === '\n') { this.skipLf = false; continue; }
      this.skipLf = false;
      if (character !== '\r' && character !== '\n') {
        this.line += character;
        if (this.line.length + this.size > 1_048_576) throw new ApiHttpError('INVALID_RESPONSE', 'SSE frame exceeds 1 MiB', 200);
        continue;
      }
      this.skipLf = character === '\r';
      if (this.line === '') {
        if (this.data.length) events.push({ ...(this.id !== undefined ? { id: this.id } : {}), ...(this.event ? { event: this.event } : {}), data: this.data.join('\n') });
        this.data = [];
        this.size = 0;
        this.event = undefined;
      } else {
        const separator = this.line.indexOf(':');
        const field = separator < 0 ? this.line : this.line.slice(0, separator);
        let value = separator < 0 ? '' : this.line.slice(separator + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') { this.data.push(value); this.size += value.length + 1; }
        else if (field === 'id' && !value.includes('\0')) this.id = value;
        else if (field === 'event') this.event = value;
      }
      this.line = '';
    }
    return events;
  }
}
