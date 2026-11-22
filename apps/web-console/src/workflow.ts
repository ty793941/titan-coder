import type { Artifact, Stage } from "./types";

export const stages = [
  {
    id: "questions",
    label: "问题确认",
    short: "Q",
    hint: "明确目标与验收标准",
  },
  { id: "research", label: "研究分析", short: "R", hint: "记录依据与约束" },
  { id: "design", label: "方案设计", short: "D", hint: "定义实现方案" },
  { id: "structure", label: "结构拆解", short: "S", hint: "确定模块与边界" },
  { id: "plan", label: "执行计划", short: "P", hint: "审阅可执行步骤" },
  { id: "implement", label: "开发执行", short: "I", hint: "启动受控本机运行" },
] as const;
export const stageLabel = (stage: string) =>
  stages.find((item) => item.id === stage)?.label ??
  { verify: "验证", review: "评审", delivered: "已交付" }[stage] ??
  stage;
export const latestArtifact = (artifacts: Artifact[], type: string) =>
  artifacts
    .filter((item) => item.type === type)
    .sort((a, b) => b.version - a.version)[0];
export function upstreamFor(artifacts: Artifact[], type: string) {
  const index = stages.findIndex((item) => item.id === type);
  return index > 0
    ? latestArtifact(artifacts, stages[index - 1]!.id)
    : undefined;
}
export function approvedChain(artifacts: Artifact[], through = "plan") {
  let previous: Artifact | undefined;
  for (const stage of stages.slice(0, 5)) {
    const current = latestArtifact(artifacts, stage.id);
    if (
      !current ||
      current.reviewState !== "approved" ||
      current.status === "archived"
    )
      return false;
    if (previous && !current.sourceArtifacts.includes(previous.artifactId))
      return false;
    previous = current;
    if (stage.id === through) return true;
  }
  return false;
}
export function runBlocker(
  stage: Stage,
  artifacts: Artifact[],
  daemonRunning: boolean,
  configured: boolean,
) {
  if (stage !== "implement")
    return "请先完成阶段审批，并将任务推进到开发执行。";
  if (!approvedChain(artifacts))
    return "最新计划或上游审批已失效，请回到任务面板检查。";
  if (!configured) return "请先在环境与 Key 中配置此模型的 API Key。";
  if (!daemonRunning) return "请先启动本机 Daemon，并确认设备在线。";
  return "";
}
export const statusLabel = (status: string) =>
  ({
    queued: "排队中",
    starting: "启动中",
    running: "运行中",
    waiting_input: "等待输入",
    paused: "已暂停",
    reconnecting: "重连中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    online: "在线",
    ready: "就绪",
    disconnected: "已断开",
    revoked: "已撤销",
    draining: "停止接单",
    offline: "离线",
    pending: "待批准",
    approved: "已批准",
    changes_requested: "需修改",
    active: "进行中",
    draft: "草稿",
    registered: "已注册",
  })[status] ?? status;
export const shortId = (value: string) =>
  value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
export function formatTime(value?: string) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "—";
}
