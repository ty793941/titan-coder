import { describe, expect, it, vi } from "vitest";
import { runConversation } from "../src/conversation.js";
import type { RuntimeAdapter, RuntimeSessionConfig } from "@titan/agent-core";

function fixture(events: Array<{ type: string; payload?: unknown }>) {
  const adapter = {
    createSession: vi.fn(async (_config: RuntimeSessionConfig) => ({
      id: "thread-test",
      runtime: "codex" as const,
    })),
    sendInput: vi.fn(async () => {}),
    streamEvents: async function* () {
      yield* events;
    },
    close: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  return adapter;
}
const input = {
  provider: "codex" as const,
  credential: "private-credential-value",
  baseUrl: "http://127.0.0.1:7999/v1",
  sandbox: "/tmp",
  context: {
    projectId: "project-1",
    name: "退款项目",
    goal: "让客户了解退款进度",
    tasks: [],
  },
  history: [],
  text: "现在应优先关注什么？",
};

describe("只读项目经理问答", () => {
  it("复用原生适配器并关闭会话，回复中的凭证和URL会被去除", async () => {
    const adapter = fixture([
      {
        type: "text",
        payload: {
          text: `建议先确认范围。${input.credential} ${input.baseUrl}`,
        },
      },
      { type: "session.completed" },
    ]);
    const text = await runConversation(
      input,
      adapter as unknown as RuntimeAdapter,
      new AbortController().signal,
    );
    expect(text).toContain("建议先确认范围");
    expect(text).not.toContain(input.credential);
    expect(text).not.toContain(input.baseUrl);
    expect(adapter.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [],
        cwd: "/tmp",
        workspace: "/tmp",
        runtime: "codex",
      }),
    );
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });
  it("不执行模型请求的任何工具", async () => {
    const adapter = fixture([
      { type: "tool.requested", payload: { name: "workspace.write" } },
    ]);
    await expect(
      runConversation(
        input,
        adapter as unknown as RuntimeAdapter,
        new AbortController().signal,
      ),
    ).rejects.toThrow("CONVERSATION_READ_ONLY");
    expect(adapter.close).toHaveBeenCalled();
  });
  it("已取消请求不会启动模型", async () => {
    const adapter = fixture([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runConversation(
        input,
        adapter as unknown as RuntimeAdapter,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(adapter.createSession).not.toHaveBeenCalled();
  });
  it("不把未完成的模型输出当作成功回复", async () => {
    const adapter = fixture([{ type: "text", payload: "部分回复" }]);
    await expect(
      runConversation(
        input,
        adapter as unknown as RuntimeAdapter,
        new AbortController().signal,
      ),
    ).rejects.toThrow("CONVERSATION_INCOMPLETE");
  });
  it("项目上下文与回复中的私有链接或多重凭证不会外泄", async () => {
    const adapter = fixture([
      {
        type: "text",
        payload:
          "https://internal-api.example.com/v1 sk-example111111 sk-example222222",
      },
      { type: "session.completed" },
    ]);
    const reply = await runConversation(
      {
        ...input,
        context: {
          ...input.context,
          goal: "https://internal-api.example.com/v1",
        },
      },
      adapter as unknown as RuntimeAdapter,
      new AbortController().signal,
    );
    expect(JSON.stringify(adapter.sendInput.mock.calls)).not.toContain(
      "internal-api.example.com",
    );
    expect(reply).not.toContain("internal-api.example.com");
    expect(reply).not.toContain("sk-example");
  });
  it("历史上下文有界，避免把所有长回复反复发送给模型", async () => {
    const adapter = fixture([
      { type: "text", payload: "建议先确认范围" },
      { type: "session.completed" },
    ]);
    await runConversation(
      {
        ...input,
        history: Array.from({ length: 40 }, () => ({
          text: "问".repeat(4000),
          reply: "答".repeat(16000),
        })),
      },
      adapter as unknown as RuntimeAdapter,
      new AbortController().signal,
    );
    expect(JSON.stringify(adapter.sendInput.mock.calls).length).toBeLessThan(
      40000,
    );
  });
});
