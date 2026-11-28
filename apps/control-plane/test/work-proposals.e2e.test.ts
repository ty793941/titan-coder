import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../src/test-app.js';
import { ConversationDaemon } from '../../daemon/dist/conversations.js';
import { createGateway } from '../../web-console/server/gateway.mjs';

const listening = async (server: Server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; };
describe('工作提案后端全链路', () => {
  it('模型夹具生成→私有历史恢复→显式确认→真实Task/Artifact→响应丢失重放', async () => {
    const token = 'offline-proposal-console';
    vi.stubEnv('TITAN_CONSOLE_TOKEN', token);
    const api = await createTestApp();
    const root = await mkdtemp(join(tmpdir(), 'titan-proposals-e2e-'));
    const proposal = { title: '后端退款状态', goal: '客户查询退款进度', acceptanceCriteria: ['可以查询状态'], priority: 'medium', questions: '# 问题确认\n需要提供状态查询和异常解释。' };
    const execute = vi.fn(async () => JSON.stringify(proposal));
    let service = new ConversationDaemon(join(root, 'history'), { execute, credentialResolver: async () => 'offline-proposal-credential' });
    const cp = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = req.method === 'POST' ? api.post(req.url!).send(JSON.parse(Buffer.concat(chunks).toString())) : api.get(req.url!);
      const result = await request.set('Authorization', req.headers.authorization || '');
      res.writeHead(result.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(result.body));
    });
    const controlPlaneUrl = await listening(cp);
    const conversations = {
      request: async (operation: string, projectId: string, input?: unknown, context?: unknown) => operation === 'send'
        ? service.send(context as Parameters<ConversationDaemon['send']>[0], input)
        : service.read(projectId),
      close: () => service.close(),
    };
    const gateway = createGateway({ root, controlPlaneUrl, consoleToken: token, conversations,
      keychain: { configured: async () => true, save: async () => {} },
      daemon: { status: async () => ({ running: false }), start: async () => ({ running: false }), stop: async () => ({ running: false }) },
    });
    try {
      const base = await listening(gateway.server);
      const status = await (await fetch(`${base}/local-api/status`)).json();
      const headers = { origin: base, 'content-type': 'application/json', 'x-titan-csrf': status.csrfToken };
      const path = `${base}/local-api/projects/project_dev/conversation`;
      const sent = await fetch(`${path}/turns`, { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), text: '生成退款工作目标与问题确认', provider: 'qwen', mode: 'work-proposal' }) });
      expect(sent.status).toBe(202);
      await vi.waitFor(async () => expect((await service.read('project_dev')).turns[0]?.status).toBe('completed'));
      await service.close();
      service = new ConversationDaemon(join(root, 'history'));
      const turn = (await (await fetch(path)).json()).turns[0];
      expect(turn.proposal).toEqual(proposal);
      const confirmation = { turnId: turn.id, proposalChecksum: turn.proposalChecksum, confirmed: true };
      const post = () => fetch(`${path}/accept`, { method: 'POST', headers, body: JSON.stringify(confirmation) });
      const accepted = await post(); expect(accepted.status).toBe(201);
      const first = await accepted.json();
      const replay = await post(); expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(first);
      expect(first.artifact).toMatchObject({ reviewState: 'pending', status: 'draft', taskId: first.task.id });
      const content = await api.get(`/api/artifacts/${first.artifact.artifactId}/content`).set('Authorization', `Bearer ${token}`).expect(200);
      expect(content.body.content).toBe(proposal.questions);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await api.db.selectFrom('execution_job').select('id').execute()).toEqual([]);
    } finally {
      await gateway.close(); cp.closeAllConnections(); await new Promise<void>(resolve => cp.close(() => resolve()));
      await api.close(); vi.unstubAllEnvs();
    }
  });
});
