// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkProposalCard from "../src/components/product/WorkProposalCard.vue";
import { api, ApiError } from "../src/api";
import type { WorkProposalAccepted } from "../src/api";
import type { ConversationTurn } from "@titan/contracts";

const turn: ConversationTurn = {
  id: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  fingerprint: "a".repeat(64),
  text: "让客户知道退款进度",
  provider: "qwen",
  status: "completed",
  mode: "work-proposal",
  createdAt: "2026-11-28T10:00:00Z",
  proposalChecksum: `sha256:${"a".repeat(64)}`,
  proposal: {
    title: "退款进度目标",
    goal: "减少重复咨询",
    acceptanceCriteria: ["客户可查进度", "异常原因可追溯"],
    priority: "high",
    questions: "# 问题确认\n<img src=x onerror=alert(1)>\n未知事项待确认。",
  },
};
const result: WorkProposalAccepted = {
  sourceTurnId: turn.id,
  proposalChecksum: turn.proposalChecksum!,
  task: {
    id: "task-new",
    projectId: "project-test",
    title: "退款进度目标",
    goal: "减少重复咨询",
    acceptanceCriteria: ["客户可查进度"],
    priority: "high",
    stage: "questions",
    status: "active",
    version: 1,
    createdAt: turn.createdAt,
  },
  artifact: {
    artifactId: "artifact-new",
    taskId: "task-new",
    type: "questions",
    status: "draft",
    reviewState: "pending",
    version: 1,
    checksum: "sha256:fixture",
    sourceArtifacts: [],
    uri: "artifact://fixture",
  },
};
describe("工作提案人工确认", () => {
  beforeEach(() =>
    vi.spyOn(api, "acceptWorkProposal").mockResolvedValue(result),
  );
  it("只展示保存的提案，阅读不会保存或批准", async () => {
    const wrapper = mount(WorkProposalCard, {
      props: { projectId: "project-test", turn, csrfToken: "local-csrf" },
    });
    expect(wrapper.text()).toContain("退款进度目标");
    expect(wrapper.text()).toContain("客户可查进度");
    expect(wrapper.text()).toContain("未知事项待确认");
    expect(wrapper.find("img").exists()).toBe(false);
    expect(api.acceptWorkProposal).not.toHaveBeenCalled();
    const approve = vi.spyOn(api, "approveArtifact");
    await wrapper.get('[data-action="accept-proposal"]').trigger("click");
    await flushPromises();
    expect(api.acceptWorkProposal).toHaveBeenCalledWith(
      "project-test",
      {
        turnId: turn.id,
        proposalChecksum: turn.proposalChecksum,
        confirmed: true,
      },
      "local-csrf",
    );
    expect(wrapper.text()).toContain("草稿仍待审批");
    expect(approve).not.toHaveBeenCalled();
    expect(wrapper.emitted("accepted")?.[0]).toEqual([result]);
    wrapper.unmount();
  });
  it("确认响应丢失时用同一来源和版本重试，不重新调用模型", async () => {
    const accept = vi
      .spyOn(api, "acceptWorkProposal")
      .mockRejectedValueOnce(
        new ApiError(503, "CONTROL_PLANE_UNAVAILABLE", "private-secret"),
      );
    const wrapper = mount(WorkProposalCard, {
      props: { projectId: "project-test", turn, csrfToken: "local-csrf" },
    });
    await wrapper.get('[data-action="accept-proposal"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).not.toContain("private-secret");
    await wrapper.get('[data-action="accept-proposal"]').trigger("click");
    await flushPromises();
    expect(accept.mock.calls[0]).toEqual(accept.mock.calls[1]);
    expect(accept).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
  it("冲突后要求重新读取并重新审阅，不继续确认旧版本", async () => {
    vi.spyOn(api, "acceptWorkProposal").mockRejectedValueOnce(
      new ApiError(409, "CONVERSATION_PROPOSAL_CONFLICT", "raw body"),
    );
    const wrapper = mount(WorkProposalCard, {
      props: { projectId: "project-test", turn, csrfToken: "local-csrf" },
    });
    await wrapper.get('[data-action="accept-proposal"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("重新读取");
    expect(
      wrapper.get('[data-action="accept-proposal"]').attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.text()).not.toContain("raw body");
    wrapper.unmount();
  });
  it.each(["running", "failed", "cancelled"] as const)(
    "%s 回合没有确认入口",
    (status) => {
      const wrapper = mount(WorkProposalCard, {
        props: {
          projectId: "project-test",
          turn: { ...turn, status },
          csrfToken: "local-csrf",
        },
      });
      expect(wrapper.find('[data-action="accept-proposal"]').exists()).toBe(
        false,
      );
      wrapper.unmount();
    },
  );
  it("没有CSRF时禁止保存，确认不会依赖仍然可用的模型凭证", () => {
    const wrapper = mount(WorkProposalCard, {
      props: { projectId: "project-test", turn, csrfToken: "" },
    });
    expect(
      wrapper.get('[data-action="accept-proposal"]').attributes("disabled"),
    ).toBeDefined();
    wrapper.unmount();
  });
  it("确认期间不重复提交，成功后查看目标和审批使用服务端返回ID", async () => {
    let finish!: (value: WorkProposalAccepted) => void;
    const accept = vi.spyOn(api, "acceptWorkProposal").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const wrapper = mount(WorkProposalCard, {
      props: { projectId: "project-test", turn, csrfToken: "local-csrf" },
    });
    await wrapper.get('[data-action="accept-proposal"]').trigger("click");
    expect(
      wrapper.get('[data-action="accept-proposal"]').attributes("disabled"),
    ).toBeDefined();
    await wrapper.get('[data-action="accept-proposal"]').trigger("click");
    expect(accept).toHaveBeenCalledTimes(1);
    finish(result);
    await flushPromises();
    const buttons = wrapper.findAll("button");
    await buttons
      .find((button) => button.text().includes("查看工作目标"))!
      .trigger("click");
    await buttons
      .find((button) => button.text().includes("进入草稿审批"))!
      .trigger("click");
    expect(wrapper.emitted("task")?.[0]).toEqual(["task-new"]);
    expect(wrapper.emitted("review")?.[0]).toEqual(["artifact-new"]);
    wrapper.unmount();
  });
  it("卸载后迟到的确认结果不发出项目导航事件", async () => {
    let finish!: (value: WorkProposalAccepted) => void;
    vi.spyOn(api, "acceptWorkProposal").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const wrapper = mount(WorkProposalCard, {
      props: { projectId: "project-test", turn, csrfToken: "local-csrf" },
    });
    await wrapper.get('[data-action="accept-proposal"]').trigger("click");
    wrapper.unmount();
    finish(result);
    await flushPromises();
    expect(wrapper.emitted("accepted")).toBeUndefined();
  });
});
