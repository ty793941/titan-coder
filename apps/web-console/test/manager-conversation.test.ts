// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ManagerConversation from "../src/components/product/ManagerConversation.vue";
import { api, ApiError } from "../src/api";

const local = {
  csrfToken: "local-csrf",
  workspaceRoot: "/workspace",
  platform: "darwin",
  controlPlane: { reachable: true },
  daemon: { running: true },
  credentials: [
    {
      provider: "qwen" as const,
      configured: true,
      credentialRef: "keychain://titan-qwen",
    },
  ],
};
const turn = {
  id: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  fingerprint: "a".repeat(64),
  provider: "qwen" as const,
  text: "下一步关注什么？",
  reply: "先确认退款范围和成功标准。",
  status: "completed" as const,
  createdAt: "2026-11-27T10:00:00Z",
};
describe("正式项目经理对话", () => {
  beforeEach(() => {
    vi.spyOn(api, "conversation").mockResolvedValue({
      projectId: "project-test",
      turns: [],
    });
  });
  it("读取历史不调用模型，发送时带项目和CSRF且显示真实回复", async () => {
    const send = vi
      .spyOn(api, "sendConversation")
      .mockResolvedValue({ projectId: "project-test", turns: [turn] });
    const wrapper = mount(ManagerConversation, {
      props: { projectId: "project-test", local },
    });
    await flushPromises();
    expect(send).not.toHaveBeenCalled();
    await wrapper.get("textarea").setValue(turn.text);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(send).toHaveBeenCalledWith(
      "project-test",
      expect.objectContaining({
        text: turn.text,
        provider: "qwen",
        requestId: expect.any(String),
      }),
      "local-csrf",
    );
    expect(send.mock.calls[0]![1].mode).toBeUndefined();
    expect(wrapper.text()).toContain(turn.reply);
    wrapper.unmount();
  });
  it("显式选择生成提案后才使用结构化模式，同模式重试复用ID，切换意图更换ID", async () => {
    const send = vi
      .spyOn(api, "sendConversation")
      .mockRejectedValue(new ApiError(0, "NETWORK_UNAVAILABLE", "lost"));
    const wrapper = mount(ManagerConversation, {
      props: { projectId: "project-test", local },
    });
    await flushPromises();
    await wrapper.get("#manager-mode").setValue("work-proposal");
    await wrapper.get("textarea").setValue("为退款进度建立可验收目标");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(send.mock.calls[0]![1].mode).toBe("work-proposal");
    expect(send.mock.calls[0]![1].requestId).toBe(
      send.mock.calls[1]![1].requestId,
    );
    await wrapper.get("#manager-mode").setValue("question");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(send.mock.calls[2]![1].mode).toBeUndefined();
    expect(send.mock.calls[2]![1].requestId).not.toBe(
      send.mock.calls[1]![1].requestId,
    );
    wrapper.unmount();
  });

  it("刷新恢复的工作提案显示全文和确认入口，普通问答没有确认入口", async () => {
    vi.spyOn(api, "conversation").mockResolvedValue({
      projectId: "project-test",
      turns: [
        turn,
        {
          ...turn,
          id: "33333333-3333-4333-8333-333333333333",
          mode: "work-proposal",
          proposalChecksum: `sha256:${"a".repeat(64)}`,
          proposal: {
            title: "退款目标",
            goal: "减少咨询",
            acceptanceCriteria: ["进度可查"],
            priority: "medium",
            questions: "# 问题确认\n请审阅范围，未知事项待确认。",
          },
        },
      ],
    });
    const accept = vi.spyOn(api, "acceptWorkProposal");
    const wrapper = mount(ManagerConversation, {
      props: { projectId: "project-test", local },
    });
    await flushPromises();
    expect(wrapper.findAll('[data-action="accept-proposal"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("未知事项待确认");
    expect(accept).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("重开面板显示历史，不发送问题", async () => {
    vi.spyOn(api, "conversation").mockResolvedValue({
      projectId: "project-test",
      turns: [turn],
    });
    const send = vi.spyOn(api, "sendConversation");
    const wrapper = mount(ManagerConversation, {
      props: { projectId: "project-test", local },
    });
    await flushPromises();
    expect(wrapper.text()).toContain(turn.text);
    expect(wrapper.text()).toContain(turn.reply);
    expect(send).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("发送响应丢失时复用同一请求ID重试", async () => {
    const send = vi
      .spyOn(api, "sendConversation")
      .mockRejectedValueOnce(new ApiError(0, "NETWORK_UNAVAILABLE", "lost"))
      .mockResolvedValue({ projectId: "project-test", turns: [turn] });
    const wrapper = mount(ManagerConversation, {
      props: { projectId: "project-test", local },
    });
    await flushPromises();
    await wrapper.get("textarea").setValue(turn.text);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1].requestId).toBe(
      send.mock.calls[1]![1].requestId,
    );
    wrapper.unmount();
  });
  it("有待回复回合时显示停止按钮，取消只针对当前回合", async () => {
    vi.spyOn(api, "conversation").mockResolvedValue({
      projectId: "project-test",
      turns: [{ ...turn, status: "running" }],
    });
    const cancel = vi.spyOn(api, "cancelConversation").mockResolvedValue({
      projectId: "project-test",
      turns: [{ ...turn, status: "cancelled" }],
    });
    const wrapper = mount(ManagerConversation, {
      props: { projectId: "project-test", local },
    });
    await flushPromises();
    const button = wrapper
      .findAll("button")
      .find((item) => item.text().includes("停止回复"))!;
    await button.trigger("click");
    await flushPromises();
    expect(cancel).toHaveBeenCalledWith("project-test", turn.id, "local-csrf");
    expect(wrapper.text()).toContain("本轮回复已停止");
    wrapper.unmount();
  });
  it("缺少模型凭证时提供环境入口并阻止发送", async () => {
    const wrapper = mount(ManagerConversation, {
      props: {
        projectId: "project-test",
        local: { ...local, credentials: [] },
      },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("配置模型");
    expect(
      wrapper.get('button[type="submit"]').attributes("disabled"),
    ).toBeDefined();
    wrapper.unmount();
  });
  it("读取失败显示固定提示，不回显服务端错误", async () => {
    vi.spyOn(api, "conversation").mockRejectedValue(
      new ApiError(500, "CONVERSATION_UNAVAILABLE", "private /secret/path"),
    );
    const wrapper = mount(ManagerConversation, {
      props: { projectId: "project-test", local },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("暂不可用");
    expect(wrapper.text()).not.toContain("/secret/path");
    wrapper.unmount();
  });
});
