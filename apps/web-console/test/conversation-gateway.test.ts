import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "../server/gateway.mjs";
import { randomUUID } from "node:crypto";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
async function fixture() {
  const conversations = {
    request: vi.fn(
      async (
        _operation: string,
        projectId: string,
        _input?: unknown,
        _context?: unknown,
      ) => ({ projectId, turns: [] }),
    ),
    close: vi.fn(async () => {}),
  };
  const cp = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
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
  return { base, token, conversations };
}
describe("本机项目经理网关", () => {
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
