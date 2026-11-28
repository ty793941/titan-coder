import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "../server/gateway.mjs";
import { createHash, randomUUID } from "node:crypto";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
async function fixture(turns: unknown[] = []) {
  const conversations = {
    request: vi.fn(
      async (
        _operation: string,
        projectId: string,
        _input?: unknown,
        _context?: unknown,
      ) => ({ projectId, turns }),
    ),
    close: vi.fn(async () => {}),
  };
  const accepted: unknown[] = [];
  const cp = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith('/work-proposals/accept')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      accepted.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.statusCode = 201;
      res.end(JSON.stringify({ sourceTurnId: (accepted.at(-1) as { sourceTurnId: string }).sourceTurnId, task: { id: 'task-created' }, artifact: { artifactId: 'artifact-created', reviewState: 'pending' } }));
      return;
    }
    res.end(
      JSON.stringify({
        projects: [{ id: "project-test", name: "退款项目", goal: "透明退款" }],
        tasks: [
          {
            id: "task-1",
            projectId: "project-test",
            title: "明确范围",
            stage: "questions",
            status: "active",
            goal: "do not forward this prompt",
          },
        ],
        sessions: [],
        runs: [],
        daemons: [],
      }),
    );
  });
  cp.listen(0, "127.0.0.1");
  await once(cp, "listening");
  const gateway = createGateway({
    root: process.cwd(),
    consoleToken: "test-only-auth",
    controlPlaneUrl: `http://127.0.0.1:${(cp.address() as { port: number }).port}`,
    conversations,
  });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const base = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  const token = (await (await fetch(`${base}/local-api/status`)).json())
    .csrfToken;
  cleanup.push(async () => {
    await gateway.close();
    cp.closeAllConnections();
    await new Promise<void>((resolve) => cp.close(() => resolve()));
  });
  return { base, token, conversations, accepted };
}
describe("本机项目经理网关", () => {
  it('不允许通用API代理绕过本机历史确认和CSRF', async () => {
    const h = await fixture();
    for (const path of ['/api/projects/project-test/work-proposals/accept', '/api/projects/project-test/work-proposals/accept/']) {
      const response = await fetch(`${h.base}${path}`, { method: 'POST', headers: { origin: h.base, 'content-type': 'application/json' }, body: JSON.stringify({ sourceTurnId: randomUUID(), confirmed: true }) });
      expect(response.status).toBe(403);
    }
    expect(h.accepted).toHaveLength(0);
    expect(h.conversations.request).not.toHaveBeenCalled();
  });
  it('只从本项目已完成回合读取提案并确认，拒绝客户端替换正文', async () => {
    const proposal = { title: '退款', goal: '透明退款', acceptanceCriteria: ['可查进度'], priority: 'medium', questions: '# 问题确认' };
    const proposalChecksum = `sha256:${createHash('sha256').update(JSON.stringify(proposal)).digest('hex')}`;
    const turnId = randomUUID();
    const h = await fixture([{ id: turnId, status: 'completed', mode: 'work-proposal', proposal, proposalChecksum }]);
    const send = (body: unknown, token = h.token) => fetch(`${h.base}/local-api/projects/project-test/conversation/accept`, { method: 'POST', headers: { origin: h.base, 'content-type': 'application/json', 'x-titan-csrf': token }, body: JSON.stringify(body) });
    const input = { turnId, proposalChecksum, confirmed: true };
    expect((await send(input)).status).toBe(201);
    expect(h.accepted).toEqual([{ sourceTurnId: turnId, proposalChecksum, confirmed: true, proposal }]);
    expect((await send({ ...input, proposal: { ...proposal, title: '替换' } })).status).toBe(400);
    expect((await send({ ...input, proposalChecksum: `sha256:${'0'.repeat(64)}` })).status).toBe(409);
    expect((await send({ ...input, turnId: randomUUID() })).status).toBe(404);
    const crossProject = await fetch(`${h.base}/local-api/projects/project-other/conversation/accept`, { method: 'POST', headers: { origin: h.base, 'content-type': 'application/json', 'x-titan-csrf': h.token }, body: JSON.stringify(input) });
    expect(crossProject.status).toBe(404);
    expect((await send(input, '')).status).toBe(403);
    expect(h.accepted).toHaveLength(1);
  });
  it.each(['running', 'failed', 'cancelled'])('未完成提案不能确认：%s', async status => {
    const turnId = randomUUID();
    const h = await fixture([{ id: turnId, status, mode: 'work-proposal' }]);
    const result = await fetch(`${h.base}/local-api/projects/project-test/conversation/accept`, { method: 'POST', headers: { origin: h.base, 'content-type': 'application/json', 'x-titan-csrf': h.token }, body: JSON.stringify({ turnId, proposalChecksum: `sha256:${'a'.repeat(64)}`, confirmed: true }) });
    expect(result.status).toBe(409);
    expect(h.accepted).toHaveLength(0);
  });
  it("只转发当前项目的有界上下文，不转发任务Prompt", async () => {
    const h = await fixture();
    const result = await fetch(
      `${h.base}/local-api/projects/project-test/conversation/turns`,
      {
        method: "POST",
        headers: {
          origin: h.base,
          "content-type": "application/json",
          "x-titan-csrf": h.token,
        },
        body: JSON.stringify({
          requestId: randomUUID(),
          text: "下一步是什么？",
          provider: "qwen",
        }),
      },
    );
    expect(result.status).toBe(202);
    expect(h.conversations.request).toHaveBeenCalledWith(
      "send",
      "project-test",
      expect.objectContaining({ provider: "qwen" }),
      expect.objectContaining({ projectId: "project-test" }),
    );
    expect(JSON.stringify(h.conversations.request.mock.calls)).not.toContain(
      "do not forward",
    );
  });
  it("不允许无CSRF或外部来源发送问题", async () => {
    const h = await fixture();
    const result = await fetch(
      `${h.base}/local-api/projects/project-test/conversation/turns`,
      {
        method: "POST",
        headers: { origin: h.base, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      },
    );
    expect(result.status).toBe(403);
    expect(h.conversations.request).not.toHaveBeenCalled();
  });
  it("项目不存在时不读取或生成对话", async () => {
    const h = await fixture();
    const result = await fetch(
      `${h.base}/local-api/projects/project-other/conversation`,
    );
    expect(result.status).toBe(404);
    expect(h.conversations.request).not.toHaveBeenCalled();
  });
  it("拒绝请求注入URL工具或凭证字段", async () => {
    const h = await fixture();
    const result = await fetch(
      `${h.base}/local-api/projects/project-test/conversation/turns`,
      {
        method: "POST",
        headers: {
          origin: h.base,
          "content-type": "application/json",
          "x-titan-csrf": h.token,
        },
        body: JSON.stringify({
          requestId: randomUUID(),
          text: "hello",
          provider: "qwen",
          baseUrl: "http://outside.invalid",
        }),
      },
    );
    expect(result.status).toBe(400);
    expect(h.conversations.request).not.toHaveBeenCalled();
  });
});
