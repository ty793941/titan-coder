import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, extname, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { providers, KeychainStore } from './keychain.mjs';
import { LocalDaemon } from './local-daemon.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const messages = {
  LOCAL_ORIGIN_REQUIRED: '仅允许从本机验收界面执行此操作。', CSRF_INVALID: '页面安全令牌已失效，请刷新后重试。',
  INVALID_CREDENTIAL: 'Key 格式不正确，请粘贴官方 API Key。', KEYCHAIN_UNAVAILABLE: '当前系统不支持 macOS 钥匙串，请使用环境变量方式。',
  KEYCHAIN_SAVE_FAILED: '保存失败，请解锁登录钥匙串并检查系统权限提示。', DAEMON_START_FAILED: 'Daemon 启动失败，请确认控制面和构建产物可用。',
  CONTROL_PLANE_UNAVAILABLE: '控制面不可用，请检查数据库与服务状态。', NOT_FOUND: '资源不存在。', INVALID_REQUEST: '请求格式不正确。',
};
const safeEqual = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function jsonBody(request, max = 8192) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > max) throw new Error('INVALID_REQUEST');
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  try { const parsed = JSON.parse(body || '{}'); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; }
  catch { throw new Error('INVALID_REQUEST'); }
}

export function createGateway({ root, controlPlaneUrl = 'http://127.0.0.1:3301', consoleToken, keychain = new KeychainStore(), daemon = new LocalDaemon(root, controlPlaneUrl), allowDevOrigin = false }) {
  const csrfToken = randomBytes(32).toString('hex');
  const dist = resolve(root, 'apps/web-console/dist');
  const server = createServer(async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(body)); };
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 5173;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(request.headers.host ?? '')) { send(403, { code: 'LOCAL_ORIGIN_REQUIRED', message: messages.LOCAL_ORIGIN_REQUIRED }); return; }
      const origin = request.headers.origin;
      const allowed = [...hosts.map(host => `http://${host}`), ...(allowDevOrigin ? ['http://127.0.0.1:5174', 'http://localhost:5174'] : [])];
      if ((origin && !allowed.includes(origin)) || request.headers['sec-fetch-site'] === 'cross-site') { send(403, { code: 'LOCAL_ORIGIN_REQUIRED', message: messages.LOCAL_ORIGIN_REQUIRED }); return; }
      const url = new URL(request.url ?? '/', `http://${hosts[0]}`);
      const mutation = !['GET', 'HEAD'].includes(request.method ?? 'GET');
      if (mutation && (!origin || !allowed.includes(origin) || !request.headers['content-type']?.startsWith('application/json'))) throw new Error('LOCAL_ORIGIN_REQUIRED');
      if (url.pathname.startsWith('/local-api/')) {
        if (mutation && !safeEqual(request.headers['x-titan-csrf'], csrfToken)) throw new Error('CSRF_INVALID');
        if (url.pathname === '/local-api/status' && request.method === 'GET') {
          let reachable = false;
          try { reachable = (await fetch(`${controlPlaneUrl}/api/console/state?limit=1`, { headers: { authorization: `Bearer ${consoleToken}` }, signal: AbortSignal.timeout(2000) })).ok; } catch {}
          send(200, { csrfToken, workspaceRoot: root, platform: process.platform, controlPlane: { reachable }, daemon: await daemon.status(), credentials: await Promise.all(Object.entries(providers).map(async ([provider, value]) => ({ provider, configured: await keychain.configured(provider), credentialRef: value.credentialRef }))) });
          return;
        }
        if (url.pathname === '/local-api/credentials' && request.method === 'POST') {
          const body = await jsonBody(request);
          if (Object.keys(body).some(key => !['provider', 'key'].includes(key)) || !Object.hasOwn(providers, body.provider)) throw new Error('INVALID_CREDENTIAL');
          await keychain.save(body.provider, body.key);
          send(200, { configured: true, credentialRef: providers[body.provider].credentialRef });
          return;
        }
        if (request.method === 'POST' && ['/local-api/daemon/start', '/local-api/daemon/stop'].includes(url.pathname)) {
          const body = await jsonBody(request);
          if (Object.keys(body).length) throw new Error('INVALID_REQUEST');
          send(200, url.pathname.endsWith('/start') ? await daemon.start() : await daemon.stop()); return;
        }
        send(404, { code: 'NOT_FOUND', message: messages.NOT_FOUND }); return;
      }
      if (url.pathname.startsWith('/api/')) {
        const controller = new AbortController();
        response.once('close', () => controller.abort());
        let body;
        if (mutation) body = JSON.stringify(await jsonBody(request, 1024 * 1024));
        const headers = {};
        for (const name of ['content-type', 'accept', 'last-event-id', 'idempotency-key']) if (typeof request.headers[name] === 'string') headers[name] = request.headers[name];
        headers.authorization = `Bearer ${consoleToken}`;
        let upstream;
        try { upstream = await fetch(`${controlPlaneUrl}${url.pathname}${url.search}`, { method: request.method, headers, ...(body ? { body } : {}), signal: controller.signal, redirect: 'error' }); }
        catch { if (!response.destroyed) throw new Error('CONTROL_PLANE_UNAVAILABLE'); return; }
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        response.flushHeaders();
        if (upstream.body) {
          const stream = Readable.fromWeb(upstream.body);
          stream.on('error', () => response.destroy()); stream.pipe(response);
        } else response.end();
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) { send(405, { code: 'INVALID_REQUEST', message: messages.INVALID_REQUEST }); return; }
      let path;
      try { path = decodeURIComponent(url.pathname); } catch { throw new Error('INVALID_REQUEST'); }
      const target = resolve(dist, path === '/' ? 'index.html' : `.${path}`);
      const child = relative(dist, target);
      if (child.startsWith('..') || isAbsolute(child)) throw new Error('NOT_FOUND');
      let actual;
      try { actual = await realpath(target); if (!(await stat(actual)).isFile()) throw new Error(); }
      catch { throw new Error('NOT_FOUND'); }
      const realRoot = await realpath(dist);
      const realChild = relative(realRoot, actual);
      if (realChild.startsWith('..') || isAbsolute(realChild)) throw new Error('NOT_FOUND');
      const content = await readFile(actual);
      response.writeHead(200, { 'content-type': mime[extname(actual)] ?? 'application/octet-stream', 'cache-control': 'no-cache',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.destroyed || response.headersSent) { response.destroy(); return; }
      const code = error instanceof Error && Object.hasOwn(messages, error.message) ? error.message : 'INVALID_REQUEST';
      send(code === 'NOT_FOUND' ? 404 : code.includes('ORIGIN') || code === 'CSRF_INVALID' ? 403 : code === 'CONTROL_PLANE_UNAVAILABLE' ? 503 : 400, { code, message: messages[code] });
    }
  });
  return { server, close: async () => { await daemon.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
