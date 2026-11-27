import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export class ConversationHost {
  constructor(root) {
    this.root = root;
    this.pending = new Map();
    this.stopped = false;
  }
  async start() {
    if (this.stopped) throw new Error("CONVERSATION_UNAVAILABLE");
    if (this.starting) return this.starting;
    if (this.child?.connected) return;
    this.starting = this.launch();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  async launch() {
    const { ProcessGroup } = await import(
      pathToFileURL(join(this.root, "apps/daemon/dist/process-group.js")).href
    );
    const group = (this.group = new ProcessGroup());
    const env = {};
    for (const name of ["PATH", "HOME", "TMPDIR", "LANG"])
      if (process.env[name]) env[name] = process.env[name];
    for (const path of [
      process.env.TITAN_CODEX_BINARY,
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    ].filter(Boolean)) {
      try {
        await access(path, constants.X_OK);
        env.TITAN_CODEX_BINARY = path;
        break;
      } catch {}
    }
    const child = (this.child = group.start(
      process.execPath,
      [
        join(this.root, "apps/daemon/dist/conversation-cli.js"),
        "--root",
        this.root,
      ],
      this.root,
      env,
      { ipc: true },
    ));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("CONVERSATION_UNAVAILABLE"));
        void group.cancel();
      }, 10000);
      const stopped = () => {
        clearTimeout(timer);
        if (this.child === child) this.child = undefined;
        for (const item of this.pending.values())
          item.reject(new Error("CONVERSATION_UNAVAILABLE"));
        this.pending.clear();
        reject(new Error("CONVERSATION_UNAVAILABLE"));
      };
      child.once("error", stopped);
      child.once("exit", stopped);
      child.on("message", (message) => {
        if (message?.type === "conversation.ready") {
          clearTimeout(timer);
          resolve();
          return;
        }
        if (message?.type !== "conversation.response") return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      });
    });
  }
  async request(operation, projectId, input, context) {
    await this.start();
    if (this.pending.size >= 32) throw new Error("CONVERSATION_BUSY");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer);
        this.pending.delete(id);
        fn(value);
      };
      const timer = setTimeout(
        () => finish(reject, new Error("CONVERSATION_UNAVAILABLE")),
        15000,
      );
      this.pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      this.child.send(
        {
          type: "conversation.request",
          id,
          operation,
          projectId,
          input,
          context,
          expiresAt: Date.now() + 10000,
        },
        (error) => {
          if (error) finish(reject, new Error("CONVERSATION_UNAVAILABLE"));
        },
      );
    });
  }
  async close() {
    this.stopped = true;
    await this.starting?.catch(() => undefined);
    if (this.group) await this.group.cancel({ killAfterMs: 5500 });
  }
}
