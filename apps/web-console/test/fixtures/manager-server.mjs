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
          await delay(700, undefined, { signal });
          yield {
            type: "text",
            payload: `离线验收回复：项目“${input.context.name}”当前有 ${input.context.tasks.length} 个工作目标。建议先明确退款范围和成功标准，再审阅阶段依据。`,
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
