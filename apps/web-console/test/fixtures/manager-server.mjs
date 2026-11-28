// 离线浏览器验收夹具：真实控制面、历史服务和 RuntimeAdapter 边界，不调用付费模型。
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensureSafeDirectory } from "../../../../packages/agent-core/dist/index.js";
import { createGateway } from "../../server/gateway.mjs";
import { waitForControlPlane } from "../../server/lifecycle.mjs";
import { ConversationDaemon } from "../../../daemon/dist/conversations.js";
import { runConversation } from "../../../agent-runtime/dist/conversation.js";

const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
await ensureSafeDirectory(join(root, ".titan"), root);
const consoleToken = randomBytes(32).toString("hex");
const controlPlaneUrl = "http://127.0.0.1:3341";
const cp = spawn(
  process.execPath,
  [join(root, "apps/control-plane/dist/main.js")],
  {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: "3341",
      TITAN_CONSOLE_TOKEN: consoleToken,
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://titan:titan@127.0.0.1:55432/titan",
    },
  },
);
const service = new ConversationDaemon(
  join(root, ".titan", "manager-browser-history"),
  {
    credentialResolver: async () => "offline-fixture-credential",
    execute: async (input, signal) => {
      const adapter = {
        createSession: async (config) => {
          if (config.tools.length) throw new Error("unexpected permission");
          return { id: "offline-native-session", runtime: input.provider };
        },
        sendInput: async () => {},
        streamEvents: async function* () {
          await delay(
            input.text.startsWith("离线验收：取消提案") ? 5000 : 700,
            undefined,
            { signal },
          );
          yield {
            type: "text",
            payload:
              input.mode === "work-proposal"
                ? input.text.startsWith("离线验收：非法提案")
                  ? "这不是有效的结构化提案"
                  : JSON.stringify({
                      title: "退款进度与异常说明 · 离线验收提案",
                      goal: "让客户清楚了解退款进度，减少重复咨询。",
                      acceptanceCriteria: [
                        "客户可查看申请、审核、到账三个阶段",
                        "异常状态显示原因与下一步建议",
                        "客服可追溯每次状态更新",
                      ],
                      priority: "high",
                      questions:
                        "# 问题确认 · 离线验收草稿\n\n## 背景\n客户目前无法清楚了解退款进度，需要反复咨询客服。\n\n## 目标与范围\n展示申请、审核、到账三个阶段，说明异常原因和建议动作。\n\n## 成功标准\n客户可查看当前阶段，客服可追溯每次状态更新。\n\n## 风险与待确认事项\n退款提供方的状态延迟、通知频率和客服权限仍待确认。\n\n本提案尚未保存、批准或执行。",
                    })
                : `离线验收回复：项目“${input.context.name}”当前有 ${input.context.tasks.length} 个工作目标。建议先明确退款范围和成功标准，再审阅阶段依据。`,
          };
          yield { type: "session.completed" };
        },
        cancel: async () => {},
        close: async () => {},
      };
      return runConversation(input, adapter, signal);
    },
  },
);
const gateway = createGateway({
  root,
  controlPlaneUrl,
  consoleToken,
  keychain: {
    configured: async (provider) => provider === "qwen",
    baseUrlConfigured: async () => false,
  },
  conversations: {
    request: (operation, projectId, input, context) =>
      operation === "send"
        ? service.send(context, input)
        : operation === "cancel"
          ? service.cancel(projectId, input.turnId)
          : service.read(projectId),
    close: () => service.close(),
  },
});
const stop = async () => {
  await gateway.close();
  cp.kill("SIGTERM");
};
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
await waitForControlPlane(cp, controlPlaneUrl, consoleToken);
gateway.server.listen(5177, "127.0.0.1");
