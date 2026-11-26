import type { Artifact, Project, Run, Session, Task } from "../types";
import { approvedChain, latestArtifact, stageLabel, statusLabel } from "../workflow";
import type { DecisionInput, DecisionPriority, ProductDecision } from "./types";

const priorityRank: Record<DecisionPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function projectName(projects: Project[], projectId: string) {
  return projects.find((project) => project.id === projectId)?.name || "未命名项目";
}

function taskPriority(task: Task): DecisionPriority {
  return task.priority;
}

function reviewDecision(projects: Project[], task: Task, artifact: Artifact): ProductDecision {
  const label = stageLabel(artifact.type);
  return {
    id: `review_artifact:${artifact.artifactId}`,
    type: "review_artifact",
    priority: taskPriority(task),
    projectId: task.projectId,
    taskId: task.id,
    title: `审阅${label}`,
    summary: `${projectName(projects, task.projectId)}中的“${task.title}”有一个新版本等待你的判断。`,
    whyNow: `版本 ${artifact.version} 已生成，后续阶段必须等你确认。`,
    recommendation: `请先阅读${label}的内容和来源，再决定是否批准。`,
    impact: "批准后可以继续推进项目阶段；要求修改会让项目经理重新整理这一阶段。",
    actionLabel: `批准${label}`,
    artifactId: artifact.artifactId,
    createdAt: artifact.createdAt || task.createdAt,
  };
}

function executionDecision(
  projects: Project[],
  task: Task,
  run: Run,
): ProductDecision {
  const status = statusLabel(run.status);
  const priority: DecisionPriority = run.status === "failed" ? "critical" : "high";
  const summary =
    run.status === "failed"
      ? `“${task.title}”的执行失败，需要你决定是否查看原因或重新安排。`
      : `“${task.title}”的执行${status}，项目经理正在等待你的判断。`;
  return {
    id: `execution_attention:${run.id}`,
    type: "execution_attention",
    priority,
    projectId: task.projectId,
    taskId: task.id,
    title: run.status === "failed" ? "执行需要接管" : "执行等待你的输入",
    summary,
    whyNow: `当前运行状态为“${status}”。`,
    recommendation: "打开执行详情，查看项目经理摘要和下一步建议。",
    impact: "在处理前不会自动创建新的执行尝试，也不会覆盖当前运行记录。",
    actionLabel: "查看并处理",
    runId: run.id,
    createdAt: run.createdAt,
  };
}

function advanceDecision(projects: Project[], task: Task, artifacts: Artifact[]): ProductDecision | undefined {
  const current = latestArtifact(artifacts, task.stage);
  if (!current || task.stage === "implement" || task.stage === "delivered") return undefined;
  if (current.reviewState !== "approved" || !approvedChain(artifacts, task.stage)) return undefined;
  const next = task.stage === "plan" ? "开发执行" : "下一阶段";
  return {
    id: `advance_stage:${task.id}:${task.version}`,
    type: "advance_stage",
    priority: taskPriority(task),
    projectId: task.projectId,
    taskId: task.id,
    title: `推进${task.title}`,
    summary: `${projectName(projects, task.projectId)}中的“${task.title}”已完成当前阶段审批。`,
    whyNow: `最新${stageLabel(task.stage)}已批准，项目可以进入${next}。`,
    recommendation: "确认当前证据和验收标准后推进阶段。",
    impact: "推进会更新任务版本，并使下一阶段成为项目经理的工作入口。",
    actionLabel: `推进至${next}`,
    createdAt: current.createdAt || task.createdAt,
  };
}

export function buildDecisions(input: DecisionInput): ProductDecision[] {
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const decisions: ProductDecision[] = [];
  for (const task of input.tasks) {
    const artifacts = input.artifactsByTask.get(task.id) || [];
    const latest = latestArtifact(artifacts, task.stage);
    if (latest && latest.reviewState === "pending")
      decisions.push(reviewDecision(input.projects, task, latest));
    const advance = advanceDecision(input.projects, task, artifacts);
    if (advance) decisions.push(advance);
  }
  const sessionById = new Map(input.sessions.map((session) => [session.id, session]));
  for (const run of input.runs) {
    if (!["waiting_input", "reconnecting", "failed"].includes(run.status)) continue;
    const task = taskById.get(sessionById.get(run.sessionId)?.taskId || "");
    if (task) decisions.push(executionDecision(input.projects, task, run));
  }
  return decisions.sort(
    (left, right) =>
      priorityRank[left.priority] - priorityRank[right.priority] ||
      right.createdAt.localeCompare(left.createdAt),
  );
}
