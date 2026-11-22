// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import RunWorkspace from "../src/components/RunWorkspace.vue";
import type { Artifact, ConsoleState, LocalStatus, Task } from "../src/types";

const task: Task = {
  id: "task-1",
  projectId: "project-1",
  title: "Acceptance",
  goal: "Write an artifact",
  stage: "implement",
  status: "active",
  version: 6,
  priority: "medium",
  acceptanceCriteria: ["Write a file"],
  createdAt: "2026-11-22T12:00:00Z",
};
const artifacts: Artifact[] = [
  "questions",
  "research",
  "design",
  "structure",
  "plan",
].map((type, index, types) => ({
  artifactId: `${type}-1`,
  type,
  version: 1,
  checksum: `sha256:${type}`,
  status: "approved",
  reviewState: "approved",
  sourceArtifacts: index ? [`${types[index - 1]}-1`] : [],
  uri: "file:///tmp/fixture.md",
}));
const state: ConsoleState = {
  projects: [],
  tasks: [task],
  sessions: [],
  runs: [],
  daemons: [
    {
      daemonId: "daemon-1",
      machineName: "Local machine",
      status: "online",
      capabilities: ["qwen"],
      workspaceRoots: ["/workspace"],
    },
  ],
};
const local: LocalStatus = {
  csrfToken: "csrf",
  workspaceRoot: "/workspace",
  platform: "darwin",
  controlPlane: { reachable: true },
  daemon: { running: true, daemonId: "daemon-1" },
  credentials: [
    {
      provider: "qwen",
      configured: true,
      credentialRef: "keychain://titan-qwen",
    },
  ],
};
describe("controlled execution form", () => {
  it("starts a session returned by the redacted console API", async () => {
    const run = vi.spyOn(api, "createRun").mockResolvedValue({ id: "run-1", sessionId: "session-1", attempt: 1, status: "queued", createdAt: "2026-11-22T12:00:00Z" });
    const wrapper = mount(RunWorkspace, { props: { task, artifacts, local, state: { ...state, sessions: [{
      id: "session-1", taskId: task.id, status: "queued", planHash: "sha256:plan", createdAt: "2026-11-22T12:00:00Z",
      execution: { daemonId: "daemon-1", runtime: "qwen", workspacePath: "/workspace", allowedTools: ["artifact.write"], maxTurns: 6, timeoutMs: 120000 },
    }] } } });
    const button = wrapper.findAll("button").find(item => item.text().includes("开始真实运行"));
    expect(button).toBeDefined();
    expect(button?.attributes("disabled")).toBeUndefined();
    await button?.trigger("click"); await flushPromises();
    expect(run).toHaveBeenCalledWith("session-1");
    wrapper.unmount();
  });
  it("creates a session with a credential reference but waits for an explicit run action", async () => {
    const create = vi
      .spyOn(api, "createSession")
      .mockResolvedValue({
        id: "session-1",
        taskId: "task-1",
        status: "queued",
        createdAt: "2026-11-22T12:00:00Z",
      });
    const run = vi.spyOn(api, "createRun");
    const wrapper = mount(RunWorkspace, {
      props: { task, artifacts, state, local },
    });
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(create).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        planHash: "sha256:plan",
        entryAgent: "project-manager",
        execution: {
          daemonId: "daemon-1",
          runtime: "qwen",
          credentialRef: "keychain://titan-qwen",
          workspacePath: "/workspace",
          allowedTools: [
            "artifact.write",
            "workspace.read",
            "workspace.search",
            "workspace.write",
          ],
          maxTurns: 6,
          timeoutMs: 120000,
        },
      }),
    );
    expect(run).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("blocks session submission while latest plan approval is missing", async () => {
    const create = vi.spyOn(api, "createSession");
    const wrapper = mount(RunWorkspace, {
      props: {
        task,
        artifacts: [
          ...artifacts,
          {
            ...artifacts[4]!,
            artifactId: "plan-2",
            version: 2,
            reviewState: "pending",
            status: "draft",
          },
        ],
        state,
        local,
      },
    });
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(create).not.toHaveBeenCalled();
    expect(
      wrapper.get('button[type="submit"]').attributes("disabled"),
    ).toBeDefined();
    wrapper.unmount();
  });
});
