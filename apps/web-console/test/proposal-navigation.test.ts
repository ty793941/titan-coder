// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import { api, ApiError } from "../src/api";
import type { Artifact, ConsoleState, Task } from "../src/types";

const task: Task = {
  id: "task-new",
  projectId: "project-test",
  title: "退款目标",
  goal: "减少咨询",
  stage: "questions",
  status: "active",
  version: 1,
  acceptanceCriteria: ["进度可查"],
  priority: "medium",
  createdAt: "2026-11-28T10:00:00Z",
};
const artifact: Artifact = {
  artifactId: "artifact-new",
  type: "questions",
  version: 1,
  checksum: "sha256:fixture",
  reviewState: "pending",
  status: "draft",
  sourceArtifacts: [],
  uri: "artifact://fixture",
};
const state: ConsoleState = {
  projects: [{ id: "project-test", name: "退款项目", goal: "减少咨询" }],
  tasks: [],
  runs: [],
  sessions: [],
  daemons: [],
};
beforeEach(async () => {
  window.location.hash = "#/projects/project-test";
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.spyOn(api, "state").mockResolvedValue(state);
  vi.spyOn(api, "localStatus").mockRejectedValue(new Error("offline"));
  vi.spyOn(api, "artifacts").mockResolvedValue([artifact]);
  vi.spyOn(api, "content").mockResolvedValue({
    content: "# 问题确认",
    checksum: "sha256:fixture",
    bytes: 16,
    format: "markdown",
  });
});
it.each(["task", "review"] as const)(
  "保存后%s入口在同步失败时保留卡片，恢复后才导航",
  async (target) => {
    const wrapper = mount(App, {
      global: {
        stubs: {
          ManagerConversation: {
            template:
              "<div><button data-task @click=\"$emit('task', 'task-new')\">查看目标</button><button data-review @click=\"$emit('review', 'artifact-new')\">审阅草稿</button></div>",
            emits: ["task", "review"],
          },
        },
      },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("询问项目经理"))!
      .trigger("click");
    vi.spyOn(api, "state").mockRejectedValueOnce(
      new ApiError(503, "NETWORK_UNAVAILABLE", "private-body"),
    );
    await wrapper.get(`[data-${target}]`).trigger("click");
    await flushPromises();
    expect(window.location.hash).toBe("#/projects/project-test");
    expect(wrapper.text()).toContain("资料尚未同步");
    expect(wrapper.text()).not.toContain("private-body");
    vi.spyOn(api, "state").mockResolvedValue({ ...state, tasks: [task] });
    await wrapper.get(`[data-${target}]`).trigger("click");
    await flushPromises();
    expect(window.location.hash).toBe(
      target === "task"
        ? "#/tasks/task-new"
        : "#/decisions/review_artifact%3Aartifact-new",
    );
    wrapper.unmount();
  },
);

it("等待目标资料期间离开项目，不被迟到刷新导航回旧目标", async () => {
  const wrapper = mount(App, {
    global: {
      stubs: {
        ManagerConversation: {
          template:
            "<button data-task @click=\"$emit('task', 'task-new')\">查看目标</button>",
          emits: ["task"],
        },
      },
    },
  });
  await flushPromises();
  await wrapper
    .findAll("button")
    .find((button) => button.text().includes("询问项目经理"))!
    .trigger("click");
  let release!: (value: ConsoleState) => void;
  vi.spyOn(api, "state").mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  await wrapper.get("[data-task]").trigger("click");
  window.location.hash = "#/projects";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  release({ ...state, tasks: [task] });
  await flushPromises();
  expect(window.location.hash).toBe("#/projects");
  wrapper.unmount();
});
