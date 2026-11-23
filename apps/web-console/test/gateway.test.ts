import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../server/gateway.mjs';
import { KeychainStore } from '../server/keychain.mjs';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'titan-ui-gateway-'));
  await mkdir(join(root, 'apps/web-console/dist'), { recursive: true });
  await writeFile(join(root, 'apps/web-console/dist/index.html'), '<main>Titan</main>');
  const saved: Array<{ provider: string; key: string }> = [];
  const keychain = { configured: async () => false, save: async (provider: string, key: string) => { if (!/^[A-Za-z0-9_.-]{12,4096}$/.test(key)) throw new Error('INVALID_CREDENTIAL'); saved.push({ provider, key }); } };
  let authorized: string | undefined;
  const bodies: string[] = [];
  const cp = createServer(async (req, res) => {
    authorized = req.headers.authorization;
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('content-type', 'application/json'); res.end('{"projects":[],"tasks":[]}');
  });
  cp.listen(0, '127.0.0.1'); await once(cp, 'listening');
  const cpAddress = cp.address() as { port: number };
  const gateway = createGateway({ root, keychain, consoleToken: 'private-console-token', controlPlaneUrl: `http://127.0.0.1:${cpAddress.port}`,
    daemon: { status: async () => ({ running: false }), start: async () => ({ running: true }), stop: async () => ({ running: false }) } });
  gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
  const base = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  cleanup.push(async () => { await gateway.close(); cp.closeAllConnections(); await new Promise<void>(resolve => cp.close(() => resolve())); });
  return { base, saved, bodies, cpPort: cpAddress.port, getAuthorization: () => authorized };
}

describe('local acceptance gateway', () => {
  it('returns only credential presence and a local CSRF token', async () => {
    const h = await fixture();
    const response = await fetch(`${h.base}/local-api/status`);
    const status = await response.json();
    expect(status.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(status.credentials).toContainEqual(expect.objectContaining({ provider: 'codex', configured: false, credentialRef: 'keychain://titan-openai', baseUrlRef: 'keychain://titan-openai-base-url', baseUrlConfigured: false }));
    expect(JSON.stringify(status)).not.toContain('private-console-token');
  });

  it('saves credentials only with same Origin and valid CSRF and never echoes the key', async () => {
    const h = await fixture();
    const { csrfToken } = await (await fetch(`${h.base}/local-api/status`)).json();
    const key = 'synthetic-offline-key-1234';
    const response = await fetch(`${h.base}/local-api/credentials`, { method: 'POST', headers: { origin: h.base, 'content-type': 'application/json', 'x-titan-csrf': csrfToken }, body: JSON.stringify({ provider: 'qwen', key }) });
    const body = await response.text();
    expect(response.status).toBe(200); expect(body).not.toContain(key);
    expect(h.saved).toEqual([{ provider: 'qwen', key }]);
  });

  it.each(['foreign-origin', 'no-origin', 'bad-csrf', 'form-post'])('rejects %s before writing a credential', async mode => {
    const h = await fixture();
    const { csrfToken } = await (await fetch(`${h.base}/local-api/status`)).json();
    const response = await fetch(`${h.base}/local-api/credentials`, { method: 'POST', headers: {
      ...(mode === 'no-origin' ? {} : { origin: mode === 'foreign-origin' ? 'https://outside.invalid' : h.base }),
      'content-type': mode === 'form-post' ? 'text/plain' : 'application/json', 'x-titan-csrf': mode === 'bad-csrf' ? 'wrong' : csrfToken,
    }, body: JSON.stringify({ provider: 'codex', key: 'synthetic-offline-key' }) });
    expect(response.status).toBe(403); expect(h.saved).toEqual([]);
  });

  it('rejects DNS rebinding host names and cross-site status reads', async () => {
    const h = await fixture();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${h.base}/local-api/status`, { headers: { host: 'outside.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    expect(status).toBe(403);
    expect((await fetch(`${h.base}/local-api/status`, { headers: { origin: 'https://outside.invalid' } })).status).toBe(403);
  });

  it('proxies facts with server-only authentication and blocks cross-origin mutations', async () => {
    const h = await fixture();
    expect((await fetch(`${h.base}/api/console/state`)).status).toBe(200);
    expect(h.getAuthorization()).toBe('Bearer private-console-token');
    expect((await fetch(`${h.base}/api/projects`, { method: 'POST', headers: { origin: 'https://outside.invalid', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  });

  it('preserves Chinese characters split across HTTP request chunks', async () => {
    const h = await fixture();
    const payload = Buffer.from(JSON.stringify({ name: '人工验收', goal: '中文正文' }));
    const split = payload.indexOf(Buffer.from('人')) + 1;
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${h.base}/api/projects`, { method: 'POST', headers: { origin: h.base, 'content-type': 'application/json' } }, response => { response.resume(); response.on('end', () => resolve()); });
      request.on('error', reject); request.write(payload.subarray(0, split));
      setTimeout(() => request.end(payload.subarray(split)), 10);
    });
    expect(JSON.parse(h.bodies.at(-1)!)).toEqual({ name: '人工验收', goal: '中文正文' });
  });

  it('refuses to proxy an old service when the dedicated control-plane port is occupied', async () => {
    const h = await fixture();
    const child = spawn(process.execPath, ['server/start.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, TITAN_CONTROL_PLANE_PORT: String(h.cpPort) } });
    let output = ''; let errors = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    const [code] = await once(child, 'exit');
    expect(code).toBe(1); expect(errors).toContain('CONTROL_PLANE_PORT_IN_USE'); expect(output).not.toContain('http://127.0.0.1:5173');
  });

  it('serves production UI with CSP and hides internal files', async () => {
    const h = await fixture();
    const response = await fetch(h.base);
    expect(await response.text()).toContain('Titan'); expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect((await fetch(`${h.base}/.env`)).status).toBe(404);
  });

  it('declines non-macOS key storage with an explicit error', async () => {
    const store = new KeychainStore('linux');
    await expect(store.save('qwen', 'synthetic-offline-key')).rejects.toThrow('KEYCHAIN_UNAVAILABLE');
    expect(await store.configured('qwen')).toBe(false);
  });

  it('passes the credential to Keychain only over stdin and validates the stored value in memory', async () => {
    const key = 'synthetic-offline-key-1234';
    let args: string[] = [];
    let script = '';
    const store = new KeychainStore('darwin', async () => ({ stdout: `${key}\n` }), (_command: string, argv: string[]) => {
      args = argv;
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; kill(): void };
      child.stdin = new PassThrough(); child.kill = () => {};
      child.stdin.on('data', chunk => { script += chunk.toString(); });
      child.stdin.on('finish', () => child.emit('close', 0));
      return child;
    });
    await store.save('codex', key);
    expect(args).toEqual(['-i']); expect(JSON.stringify(args)).not.toContain(key);
    expect(script).toContain('add-generic-password -U -s titan-openai');
    expect(script).toContain(key);
  });

  it('rejects control characters before starting the Keychain helper', async () => {
    const store = new KeychainStore('darwin', async () => { throw new Error('must not run'); }, () => { throw new Error('must not spawn'); });
    await expect(store.save('codex', 'synthetic-key\nmalicious-command')).rejects.toThrow('INVALID_CREDENTIAL');
  });
});
