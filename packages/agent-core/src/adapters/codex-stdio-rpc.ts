import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { providerError } from './provider-credentials.js';

export type RpcMessage = { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: { code?: number } };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class CodexStdioRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly exited: Promise<void>;
  private sequence = 0;
  private failure: Error | undefined;
  private stopping: Promise<void> | undefined;

  constructor(
    executable: string,
    args: string[],
    cwd: string,
    home: string,
    private readonly timeoutMs: number,
    onMessage: (message: RpcMessage) => void,
    private readonly onFailure: (error: Error) => void,
  ) {
    const env: NodeJS.ProcessEnv = { CODEX_HOME: home };
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'USER', 'SHELL', 'LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE']) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    this.child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    this.child.on('error', () => this.fail(providerError('Codex', 'App Server process unavailable')));
    this.child.on('exit', (code, signal) => this.fail(providerError('Codex', 'App Server exited', { exitCode: code, signal })));
    this.child.stdin.on('error', () => this.fail(providerError('Codex', 'App Server input closed')));
    // 消费 stderr 以避免阻塞；供应商诊断可能包含凭证，禁止转发或持久化。
    this.child.stderr.resume();
    this.child.stdout.setEncoding('utf8');
    let buffer = '';
    this.child.stdout.on('data', (chunk: string) => {
      if (this.failure) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) return this.fail(providerError('Codex', 'protocol frame exceeded limit'));
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as RpcMessage;
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
          if (typeof message.method === 'string') onMessage(message);
          else if (typeof message.id === 'number') {
            const request = this.pending.get(message.id);
            if (!request) continue;
            clearTimeout(request.timer);
            this.pending.delete(message.id);
            if (message.error) request.reject(providerError('Codex', 'App Server rejected request', { rpcCode: message.error.code }));
            else if ('result' in message) request.resolve(message.result);
            else request.reject(providerError('Codex', 'invalid RPC response'));
          } else throw new Error();
        } catch {
          this.fail(providerError('Codex', 'invalid App Server protocol message'));
          return;
        }
      }
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(providerError('Codex', 'App Server request timed out', { method })), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string): void { this.write({ method }); }
  respond(id: string | number, result: unknown): void { this.write({ id, result }); }
  reject(id: string | number): void { this.write({ id, error: { code: -32601, message: 'Client capability is unavailable' } }); }

  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = (async () => {
        this.fail(providerError('Codex', 'session closed'));
        this.child.stdin.destroy();
        this.child.kill('SIGTERM');
        const timer = setTimeout(() => this.child.kill('SIGKILL'), 250);
        try { await this.exited; } finally { clearTimeout(timer); }
      })();
    }
    return this.stopping;
  }

  private write(message: unknown): void {
    if (this.failure) throw this.failure;
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch { this.fail(providerError('Codex', 'App Server write failed')); }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.onFailure(error);
  }
}
