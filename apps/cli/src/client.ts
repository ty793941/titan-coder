export type ApiError = { code: string; message: string; traceId?: string };

export class ApiClient {
  constructor(private readonly baseUrl = process.env.TITAN_API_URL ?? 'http://127.0.0.1:3000') {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const body = await response.json() as T | ApiError;
    if (!response.ok) throw body as ApiError;
    return body as T;
  }
}
