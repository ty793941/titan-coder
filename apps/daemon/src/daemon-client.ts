import type { DaemonHeartbeat, DaemonRegistration, ProgressAck, RunDispatch, RunProgress } from '@titan/daemon-protocol';

export type DeviceCredential = { daemonId: string; authToken: string; baseUrl: string };
export type RunControl = { cancelRequested: boolean; status: string };

export class DaemonTransportError extends Error {
  constructor() { super('DAEMON_TRANSPORT_ERROR'); }
}

export class DaemonProtocolError extends Error {}

export class DaemonHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? 'DAEMON_AUTH_REJECTED' : `DAEMON_HTTP_${status}`);
  }
}

export class DaemonClient {
  readonly baseUrl: string;

  constructor(baseUrl: string, private readonly timeoutMs = 5000) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('INVALID_CONTROL_PLANE_URL');
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('CONTROL_PLANE_REQUIRES_TLS');
    this.baseUrl = url.href.replace(/\/$/, '');
  }

  async register(registration: DaemonRegistration, signal?: AbortSignal): Promise<DeviceCredential> {
    const response = await this.request('/api/daemons/register', 'POST', registration, undefined, signal) as Partial<DeviceCredential>;
    if (typeof response?.daemonId !== 'string' || !response.daemonId || typeof response.authToken !== 'string' || !response.authToken) throw new DaemonProtocolError('INVALID_REGISTRATION_RESPONSE');
    return { daemonId: response.daemonId, authToken: response.authToken, baseUrl: this.baseUrl };
  }

  async heartbeat(credential: DeviceCredential, heartbeat: DaemonHeartbeat, signal?: AbortSignal): Promise<void> {
    await this.request(`/api/daemons/${encodeURIComponent(credential.daemonId)}/heartbeat`, 'POST', heartbeat, credential, signal);
  }

  async claim(credential: DeviceCredential, signal?: AbortSignal): Promise<RunDispatch | undefined> {
    return await this.request(`/api/daemons/${encodeURIComponent(credential.daemonId)}/claim`, 'POST', {}, credential, signal) as RunDispatch | undefined;
  }

  async progress(credential: DeviceCredential, runId: string, progress: RunProgress, signal?: AbortSignal): Promise<ProgressAck> {
    const ack = await this.request(this.runPath(credential, runId, 'progress'), 'POST', progress, credential, signal) as ProgressAck;
    if (!ack || typeof ack.accepted !== 'boolean' || typeof ack.cancelRequested !== 'boolean' || typeof ack.status !== 'string') throw new DaemonProtocolError('INVALID_PROGRESS_ACK');
    return ack;
  }

  async control(credential: DeviceCredential, runId: string, signal?: AbortSignal): Promise<RunControl> {
    const control = await this.request(this.runPath(credential, runId, 'control'), 'GET', undefined, credential, signal) as RunControl;
    if (!control || typeof control.cancelRequested !== 'boolean' || typeof control.status !== 'string') throw new DaemonProtocolError('INVALID_RUN_CONTROL');
    return control;
  }

  private runPath(credential: DeviceCredential, runId: string, action: string): string {
    return `/api/daemons/${encodeURIComponent(credential.daemonId)}/runs/${encodeURIComponent(runId)}/${action}`;
  }

  private async request(path: string, method: string, body: unknown, credential?: DeviceCredential, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method, redirect: 'error',
        headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential.authToken}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch { throw new DaemonTransportError(); }
    if (!response.ok) { await response.body?.cancel(); throw new DaemonHttpError(response.status); }
    if (response.status === 204) return undefined;
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > 2 * 1024 * 1024) throw new DaemonProtocolError('CONTROL_PLANE_RESPONSE_TOO_LARGE');
        chunks.push(result.value);
      }
    } catch (error) {
      if (error instanceof DaemonProtocolError) throw error;
      throw new DaemonTransportError();
    } finally { await reader.cancel().catch(() => undefined); }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return text ? JSON.parse(text) as unknown : undefined; }
    catch { throw new DaemonProtocolError('INVALID_CONTROL_PLANE_JSON'); }
  }
}
