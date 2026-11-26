import { describe, expect, it } from "vitest";
import { buildDecisions } from "../src/product/decisions";
import type { Artifact, Project, Run, Session, Task } from "../src/types";

const project: Project = {
  id: "project-1",
  name: "支付平台",
  goal: "按期交付支付平台重构",
};
const task: Task = {
  id: "task-1",
  projectId: project.id,
  title: "完成结算接口",
  goal: "交付可验收的结算接口",
  stage: "questions",
  status: "active",
  version: 3,
  acceptanceCriteria: ["接口可调用"],
  priority: "high",
  createdAt: "2026-11-26T10:00:00Z",
};
const pendingArtifact: Artifact = {
  artifactId: "questions-2",
  type: "questions",
  version: 2,
  checksum: "sha256:questions",
  reviewState: "pending",
  status: "draft",
  sourceArtifacts: [],
  uri: "artifact://questions-2",
  createdAt: "2026-11-26T11:00:00Z",
};

describe("项目负责人决策适配器", () => {
  it("把待批准工件转换为真实决策", () => {
    const decisions = buildDecisions({
      projects: [project],
      tasks: [task],
      artifactsByTask: new Map([[task.id, [pendingArtifact]]]),
      sessions: [],
      runs: [],
    });

    expect(decisions[0]).toMatchObject({
      type: "review_artifact",
      taskId: task.id,
      artifactId: pendingArtifact.artifactId,
      actionLabel: "批准问题确认",
    });
  });

  it("把需要恢复的 Run 转换为接管决策", () => {
    const session: Session = {
      id: "session-1",
      taskId: task.id,
      status: "waiting_input",
      createdAt: "2026-11-26T11:00:00Z",
    };
    const run: Run = {
      id: "run-1",
      sessionId: session.id,
      attempt: 1,
      status: "waiting_input",
      errorCode: "WAITING_INPUT",
      createdAt: "2026-11-26T11:05:00Z",
    };
    const decisions = buildDecisions({
      projects: [project],
      tasks: [task],
      artifactsByTask: new Map(),
      sessions: [session],
      runs: [run],
    });

    expect(decisions[0]).toMatchObject({
      type: "execution_attention",
      runId: run.id,
      actionLabel: "查看并处理",
    });
  });

  it("按优先级和时间排序，并过滤敏感字段", () => {
    const decisions = buildDecisions({
      projects: [project],
      tasks: [task],
      artifactsByTask: new Map([[task.id, [pendingArtifact]]]),
      sessions: [],
      runs: [],
    });

    expect(JSON.stringify(decisions)).not.toContain("secret");
    expect(JSON.stringify(decisions)).not.toContain("prompt");
    expect(JSON.stringify(decisions)).not.toContain("checkpoint");
    expect(decisions.every((item) => item.id.includes(":"))).toBe(true);
  });

  it("没有可处理事实时返回空列表", () => {
    expect(
      buildDecisions({
        projects: [project],
        tasks: [],
        artifactsByTask: new Map(),
        sessions: [],
        runs: [],
      }),
    ).toEqual([]);
  });

  it("新尝试完成后不把历史失败重新列为待决策", () => {
    const decisions = buildDecisions({
      projects: [project],
      tasks: [task],
      artifactsByTask: new Map(),
      sessions: [
        {
          id: "session-1",
          taskId: task.id,
          status: "completed",
          createdAt: task.createdAt,
        },
      ],
      runs: [
        {
          id: "run-old",
          sessionId: "session-1",
          attempt: 1,
          status: "failed",
          createdAt: "2026-11-26T10:00:00Z",
        },
        {
          id: "run-new",
          sessionId: "session-1",
          attempt: 2,
          status: "completed",
          createdAt: "2026-11-26T11:00:00Z",
        },
      ],
    });
    expect(decisions).toEqual([]);
  });
});
