import { describe, expect, it, vi } from "vitest";
import { loadProductData } from "../src/product/useProductData";
import type { Artifact, ConsoleState, LocalStatus, Project, Task } from "../src/types";

const project: Project = { id: "project-1", name: "支付平台", goal: "交付支付平台重构" };
const tasks: Task[] = [
  {
    id: "task-1",
    projectId: project.id,
    title: "结算接口",
    goal: "完成接口",
    stage: "questions",
    status: "active",
    version: 1,
    acceptanceCriteria: [],
    priority: "medium",
    createdAt: "2026-11-26T10:00:00Z",
  },
  {
    id: "task-2",
    projectId: project.id,
    title: "对账报告",
    goal: "完成报告",
    stage: "plan",
    status: "active",
    version: 1,
    acceptanceCriteria: [],
    priority: "low",
    createdAt: "2026-11-26T10:00:00Z",
  },
];
const state: ConsoleState = {
  projects: [project],
  tasks,
  sessions: [],
  runs: [],
  daemons: [],
};
const local: LocalStatus = {
  csrfToken: "csrf",
  workspaceRoot: "/workspace",
  platform: "darwin",
  controlPlane: { reachable: true },
  daemon: { running: false },
  credentials: [],
};
const artifact: Artifact = {
  artifactId: "questions-1",
  type: "questions",
  version: 1,
  checksum: "sha256:questions",
  reviewState: "pending",
  status: "draft",
  sourceArtifacts: [],
  uri: "artifact://questions-1",
};

describe("正式产品数据加载", () => {
  it("加载状态、环境和每个任务的工件", async () => {
    const client = {
      state: vi.fn().mockResolvedValue(state),
      localStatus: vi.fn().mockResolvedValue(local),
      artifacts: vi.fn().mockImplementation(async (taskId: string) =>
        taskId === "task-1" ? [artifact] : [],
      ),
    };

    const snapshot = await loadProductData(client);
    expect(snapshot.state).toBe(state);
    expect(snapshot.local).toBe(local);
    expect(snapshot.artifactsByTask.get("task-1")).toEqual([artifact]);
    expect(snapshot.artifactsByTask.get("task-2")).toEqual([]);
    expect(snapshot.errors).toEqual([]);
  });

  it("保留其他任务数据并记录部分工件读取错误", async () => {
    const client = {
      state: vi.fn().mockResolvedValue(state),
      localStatus: vi.fn().mockRejectedValue(new Error("local unavailable")),
      artifacts: vi.fn().mockImplementation(async (taskId: string) => {
        if (taskId === "task-2") throw new Error("artifact unavailable");
        return [artifact];
      }),
    };

    const snapshot = await loadProductData(client);
    expect(snapshot.artifactsByTask.get("task-1")).toEqual([artifact]);
    expect(snapshot.artifactsByTask.get("task-2")).toEqual([]);
    expect(snapshot.errors).toEqual(["local unavailable", "artifact unavailable"]);
  });

  it("被取消后不继续请求任务工件", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = {
      state: vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")),
      localStatus: vi.fn(),
      artifacts: vi.fn(),
    };

    await expect(loadProductData(client, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(client.artifacts).not.toHaveBeenCalled();
  });
});
