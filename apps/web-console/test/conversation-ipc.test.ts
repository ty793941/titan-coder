import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationHost } from "../server/conversations.mjs";

describe("真实对话 Daemon IPC 生命周期", () => {
  it("并发读取等待就绪握手，关闭后可以重新读取同一私有目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "titan-conversation-ipc-"));
    const directory = join(root, "apps/daemon/dist");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      join(directory, "process-group.js"),
      `export { ProcessGroup } from ${JSON.stringify(new URL("../../daemon/dist/process-group.js", import.meta.url).href)};`,
    );
    await writeFile(
      join(directory, "conversation-cli.js"),
      `import ${JSON.stringify(new URL("../../daemon/dist/conversation-cli.js", import.meta.url).href)};`,
    );
    const host = new ConversationHost(root);
    try {
      const snapshots = await Promise.all([
        host.request("read", "project-one"),
        host.request("read", "project-two"),
      ]);
      expect(snapshots).toEqual([
        { projectId: "project-one", turns: [] },
        { projectId: "project-two", turns: [] },
      ]);
    } finally {
      await host.close();
    }
    const restarted = new ConversationHost(root);
    try {
      expect(await restarted.request("read", "project-one")).toEqual({
        projectId: "project-one",
        turns: [],
      });
    } finally {
      await restarted.close();
    }
  }, 25000);
});
