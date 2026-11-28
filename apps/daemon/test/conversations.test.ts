import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConversationDaemon } from "../src/conversations.js";

const context = {
  projectId: "project-test",
  name: "退款项目",
  goal: "透明退款进度",
  tasks: [],
};
const request = () => ({
  requestId: randomUUID(),
  text: "现在最需要关注什么？",
  provider: "qwen" as const,
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "titan-conversation-test-"));
  const execute = vi.fn(async () => "建议先明确成功标准。");
  return {
    directory,
    execute,
    service: new ConversationDaemon(directory, {
      execute,
      credentialResolver: async () => "offline-private-credential",
    }),
  };
}

describe("项目对话 Daemon", () => {
  it('JSON转义不能使实际凭证进入已解码提案或私有历史', async () => {
    const h = await fixture();
    const encoded = JSON.stringify({ title: '退款', goal: 'offline-private-credential', acceptanceCriteria: ['可查进度'], priority: 'medium', questions: '问题确认' }).replaceAll('o', '\\u006f');
    h.execute.mockResolvedValue(encoded);
    try {
      await h.service.send(context, { ...request(), mode: 'work-proposal' });
      await vi.waitFor(async () => expect((await h.service.read(context.projectId)).turns[0]?.status).toBe('failed'));
      const snapshot = await h.service.read(context.projectId);
      expect(snapshot.turns[0]?.errorCode).toBe('CONVERSATION_PROPOSAL_INVALID');
      expect(JSON.stringify(snapshot)).not.toContain('offline-private-credential');
      const files = (await readdir(h.directory)).filter(name => name.endsWith('.json'));
      expect(await readFile(join(h.directory, files[0]!), 'utf8')).not.toContain('offline-private-credential');
    } finally { await h.service.close(); }
  });
  it('取消与模型完成交错时不留下可确认的提案', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'titan-proposal-cancel-'));
    let resolve!: (value: string) => void;
    const service = new ConversationDaemon(directory, { credentialResolver: async () => 'offline-private-credential', execute: () => new Promise<string>(done => { resolve = done; }) });
    try {
      const snapshot = await service.send(context, { ...request(), mode: 'work-proposal' });
      resolve(JSON.stringify({ title: '退款', goal: '明确目标', acceptanceCriteria: ['明确'], priority: 'medium', questions: '问题确认' }));
      await service.cancel(context.projectId, snapshot.turns[0]!.id);
      await vi.waitFor(async () => expect((await service.read(context.projectId)).turns[0]?.status).toBe('cancelled'));
      expect((await service.read(context.projectId)).turns[0]?.proposal).toBeUndefined();
    } finally { await service.close(); }
  });
  it("保存严格提案与checksum，重试不调用模型且重启可读取", async () => {
    const h = await fixture();
    const proposal = { title: '退款进度', goal: '客户了解进度', acceptanceCriteria: ['可查询状态'], priority: 'medium', questions: '# 问题确认\n退款需要可追溯。' };
    h.execute.mockResolvedValue(JSON.stringify(proposal));
    const input = { ...request(), mode: 'work-proposal' };
    try {
      await h.service.send(context, input);
      await vi.waitFor(async () => expect((await h.service.read(context.projectId)).turns[0]?.status).toBe('completed'));
      const turn = (await h.service.read(context.projectId)).turns[0]!;
      expect(turn.proposal).toEqual(proposal);
      expect(turn.proposalChecksum).toBe(`sha256:${createHash('sha256').update(JSON.stringify(proposal)).digest('hex')}`);
      await h.service.send(context, input);
      expect(h.execute).toHaveBeenCalledTimes(1);
      expect((await new ConversationDaemon(h.directory).read(context.projectId)).turns[0]?.proposal).toEqual(proposal);
    } finally { await h.service.close(); }
  });
  it.each(['not-json', JSON.stringify({ title: '目标', allowedTools: ['workspace.write'] }), JSON.stringify({ title: '退款', goal: 'api_key=synthetic-unsafe-token', acceptanceCriteria: ['完成'], priority: 'medium', questions: '内容' })])('非法提案不作为成功回复保存：%s', async (reply) => {
    const h = await fixture(); h.execute.mockResolvedValue(reply);
    try {
      await h.service.send(context, { ...request(), mode: 'work-proposal' });
      await vi.waitFor(async () => expect((await h.service.read(context.projectId)).turns[0]?.status).toBe('failed'));
      const turn = (await h.service.read(context.projectId)).turns[0]!;
      expect(turn.errorCode).toBe('CONVERSATION_PROPOSAL_INVALID');
      expect(turn.proposal).toBeUndefined();
      expect(turn.reply).toBeUndefined();
    } finally { await h.service.close(); }
  });
  it("IPC接收时已过期的发送不启动模型", async () => {
    const h = await fixture();
    await expect(
      h.service.send(context, request(), Date.now() - 1),
    ).rejects.toThrow("CONVERSATION_UNAVAILABLE");
    expect(h.execute).not.toHaveBeenCalled();
  });
  it("关闭也会中断仍在等待凭证的发送，不发生后台延迟计费", async () => {
    const h = await fixture();
    const resolver = vi.fn(() => new Promise<string>(() => {}));
    const service = new ConversationDaemon(h.directory, {
      credentialResolver: resolver,
      execute: h.execute,
    });
    const sending = service.send(context, request()).catch(() => undefined);
    await vi.waitFor(() => expect(resolver).toHaveBeenCalled());
    const outcome = await Promise.race([
      service.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("late"), 300)),
    ]);
    expect(outcome).toBe("closed");
    await sending;
    expect(h.execute).not.toHaveBeenCalled();
  });
  it("关闭立即中止活动回复，不等待模型自然结束", async () => {
    const h = await fixture();
    let aborted = false;
    const service = new ConversationDaemon(h.directory, {
      credentialResolver: async () => "offline-private-credential",
      execute: async (_input, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }),
        ),
    });
    await service.send(context, request());
    await service.close();
    expect(aborted).toBe(true);
    expect((await service.read(context.projectId)).turns[0]?.status).toBe(
      "cancelled",
    );
  });
  it("未完成的模型回复不阻塞发送ACK，ACK丢失后同请求仍可定位并取消", async () => {
    const h = await fixture();
    const service = new ConversationDaemon(h.directory, {
      credentialResolver: async () => "offline-private-credential",
      execute: async (_input, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    });
    try {
      const input = request();
      const ack = await service.send(context, input);
      expect(ack.turns[0]?.status).toBe("running");
      expect((await service.send(context, input)).turns[0]?.id).toBe(
        ack.turns[0]?.id,
      );
      expect(
        (await service.send(context, input, Date.now() - 1)).turns[0]?.id,
      ).toBe(ack.turns[0]?.id);
      await service.cancel(context.projectId, ack.turns[0]!.id);
      await vi.waitFor(async () =>
        expect((await service.read(context.projectId)).turns[0]?.status).toBe(
          "cancelled",
        ),
      );
    } finally {
      await service.close();
    }
  });
  it("拒绝未配置的服务URL进入对话或历史", async () => {
    const h = await fixture();
    await expect(
      h.service.send(context, {
        ...request(),
        text: "使用 https://internal-api.example.com/v1",
      }),
    ).rejects.toThrow("CONVERSATION_SENSITIVE_INPUT");
    expect(h.execute).not.toHaveBeenCalled();
    expect((await h.service.read(context.projectId)).turns).toEqual([]);
  });
  it("不同项目同时解析凭证时仍保持全局最多两个调用", async () => {
    const h = await fixture();
    const service = new ConversationDaemon(h.directory, {
      credentialResolver: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "offline-private-credential";
      },
      execute: async (_input, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new Error("cancelled")),
          ),
        ),
    });
    try {
      const results = await Promise.allSettled(
        [1, 2, 3].map((id) =>
          service.send({ ...context, projectId: `project-${id}` }, request()),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(2);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
    } finally {
      await service.close();
    }
  });
  it("读取历史不调用模型，消息持久化并可在重启后读取", async () => {
    const h = await fixture();
    expect((await h.service.read(context.projectId)).turns).toEqual([]);
    expect(h.execute).not.toHaveBeenCalled();
    await h.service.send(context, request());
    await vi.waitFor(async () =>
      expect((await h.service.read(context.projectId)).turns[0]?.status).toBe(
        "completed",
      ),
    );
    const restarted = new ConversationDaemon(h.directory, {
      execute: h.execute,
    });
    expect((await restarted.read(context.projectId)).turns[0]?.reply).toContain(
      "成功标准",
    );
    const files = (await readdir(h.directory)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(files).toHaveLength(1);
    expect((await stat(join(h.directory, files[0]!))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(h.directory, files[0]!), "utf8")).not.toContain(
      "offline-private-credential",
    );
  });
  it("进程遗留中的回合读取时标记中断，不自动重新调用模型", async () => {
    const h = await fixture();
    await h.service.send(context, request());
    await vi.waitFor(async () =>
      expect((await h.service.read(context.projectId)).turns[0]?.status).toBe(
        "completed",
      ),
    );
    const file = (await readdir(h.directory)).find((name) =>
      name.endsWith(".json"),
    )!;
    const snapshot = JSON.parse(
      await readFile(join(h.directory, file), "utf8"),
    );
    snapshot.turns[0].status = "running";
    delete snapshot.turns[0].reply;
    await writeFile(join(h.directory, file), JSON.stringify(snapshot));
    const restarted = new ConversationDaemon(h.directory, {
      execute: h.execute,
    });
    expect((await restarted.read(context.projectId)).turns[0]).toMatchObject({
      status: "failed",
      errorCode: "CONVERSATION_INTERRUPTED",
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it("超时中止执行并保存安全失败状态", async () => {
    const h = await fixture();
    const service = new ConversationDaemon(h.directory, {
      timeoutMs: 10,
      credentialResolver: async () => "offline-private-credential",
      execute: async (_input, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new Error("raw provider body")),
          ),
        ),
    });
    await service.send(context, request());
    await vi.waitFor(async () =>
      expect((await service.read(context.projectId)).turns[0]).toMatchObject({
        status: "failed",
        errorCode: "CONVERSATION_TIMEOUT",
      }),
    );
    expect(JSON.stringify(await service.read(context.projectId))).not.toContain(
      "raw provider body",
    );
  });
  it("同一请求只调用一次，修改已使用请求的内容会被拒绝", async () => {
    const h = await fixture();
    const input = request();
    await Promise.all([
      h.service.send(context, input),
      h.service.send(context, input),
    ]);
    await vi.waitFor(() => expect(h.execute).toHaveBeenCalledTimes(1));
    await expect(
      h.service.send(context, { ...input, text: "不同的问题" }),
    ).rejects.toThrow("CONVERSATION_REQUEST_CONFLICT");
  });
  it("同项目单飞，取消后保留取消记录", async () => {
    const h = await fixture();
    const service = new ConversationDaemon(h.directory, {
      credentialResolver: async () => "offline-private-credential",
      execute: async (_input, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new Error("raw private error")),
          ),
        ),
    });
    const snapshot = await service.send(context, request());
    await expect(service.send(context, request())).rejects.toThrow(
      "CONVERSATION_BUSY",
    );
    await service.cancel(context.projectId, snapshot.turns[0]!.id);
    await vi.waitFor(async () =>
      expect((await service.read(context.projectId)).turns[0]?.status).toBe(
        "cancelled",
      ),
    );
  });
  it("凭证、URL和自定义工具字段不能由请求注入", async () => {
    const h = await fixture();
    await expect(
      h.service.send(context, { ...request(), apiKey: "not-allowed" }),
    ).rejects.toThrow();
    await expect(
      h.service.send(context, { ...request(), text: "api_key=secret-message" }),
    ).rejects.toThrow("CONVERSATION_SENSITIVE_INPUT");
    await expect(
      h.service.send(context, {
        ...request(),
        text: "offline-private-credential",
      }),
    ).rejects.toThrow("CONVERSATION_SENSITIVE_INPUT");
    expect(h.execute).not.toHaveBeenCalled();
  });
  it("没有凭证时不记录消息或调用模型", async () => {
    const h = await fixture();
    const service = new ConversationDaemon(h.directory, {
      credentialResolver: async () => undefined,
      execute: h.execute,
    });
    await expect(service.send(context, request())).rejects.toThrow(
      "CONVERSATION_CREDENTIAL_REQUIRED",
    );
    expect((await service.read(context.projectId)).turns).toEqual([]);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it("拒绝路径穿越和符号链接状态文件", async () => {
    const h = await fixture();
    await expect(h.service.read("../other")).rejects.toThrow();
    await h.service.send(context, request());
    await vi.waitFor(async () =>
      expect((await h.service.read(context.projectId)).turns[0]?.status).toBe(
        "completed",
      ),
    );
    const files = (await readdir(h.directory)).filter((name) =>
      name.endsWith(".json"),
    );
    const linked = await mkdtemp(join(tmpdir(), "titan-conversation-link-"));
    await symlink(join(h.directory, files[0]!), join(linked, files[0]!));
    await expect(
      new ConversationDaemon(linked).read(context.projectId),
    ).rejects.toThrow();
  });
  it("同一项目隔离历史，不把另一个项目消息带入模型", async () => {
    const h = await fixture();
    await h.service.send(context, request());
    await vi.waitFor(async () =>
      expect((await h.service.read(context.projectId)).turns[0]?.status).toBe(
        "completed",
      ),
    );
    await h.service.send({ ...context, projectId: "project-other" }, request());
    expect(h.execute.mock.calls[1]?.[0]).toMatchObject({
      context: { projectId: "project-other" },
      history: [],
    });
  });
});
