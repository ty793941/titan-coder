import { resolve, join } from "node:path";
import { ensureSafeDirectory } from "@titan/agent-core";
import { ConversationDaemon } from "./conversations.js";
import { StateLease } from "./state-lease.js";

async function main() {
  if (
    !process.send ||
    process.argv.length !== 4 ||
    process.argv[2] !== "--root"
  )
    throw new Error("CONVERSATION_IPC_REQUIRED");
  const root = resolve(process.argv[3]!);
  const directory = await ensureSafeDirectory(
    join(root, ".titan", "project-manager"),
    root,
  );
  const lease = await StateLease.acquire(directory);
  const service = new ConversationDaemon(directory);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(0), 5000);
    void service.close().finally(async () => {
      await lease.release();
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("disconnect", stop);
  process.on("message", (raw) => {
    void (async () => {
      const message = raw as {
        type?: string;
        id?: string;
        operation?: string;
        projectId?: string;
        input?: unknown;
        context?: unknown;
        expiresAt?: number;
      };
      if (
        message.type !== "conversation.request" ||
        typeof message.id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(message.id)
      )
        return;
      try {
        if (
          stopping ||
          typeof message.projectId !== "string" ||
          JSON.stringify(raw).length > 32768
        )
          throw new Error("CONVERSATION_UNAVAILABLE");
        let result;
        if (message.operation === "read")
          result = await service.read(message.projectId);
        else if (message.operation === "send") {
          const context = message.context as Parameters<
            ConversationDaemon["send"]
          >[0];
          if (context?.projectId !== message.projectId)
            throw new Error("CONVERSATION_PROJECT_MISMATCH");
          if (!Number.isSafeInteger(message.expiresAt))
            throw new Error("CONVERSATION_INVALID_REQUEST");
          result = await service.send(
            context,
            message.input,
            message.expiresAt,
          );
        } else if (message.operation === "cancel") {
          const input = message.input as { turnId?: unknown };
          if (typeof input?.turnId !== "string")
            throw new Error("CONVERSATION_INVALID_REQUEST");
          result = await service.cancel(message.projectId, input.turnId);
        } else throw new Error("CONVERSATION_INVALID_REQUEST");
        if (process.connected)
          process.send?.({
            type: "conversation.response",
            id: message.id,
            result,
          });
      } catch (error) {
        const code =
          error instanceof Error && /^CONVERSATION_[A-Z_]+$/.test(error.message)
            ? error.message
            : "CONVERSATION_INVALID_REQUEST";
        if (process.connected)
          process.send?.({
            type: "conversation.response",
            id: message.id,
            error: code,
          });
      }
    })().catch(() => undefined);
  });
  process.send({ type: "conversation.ready" });
}
void main().catch(() => {
  process.exitCode = 1;
});
