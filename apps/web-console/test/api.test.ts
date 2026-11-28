import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleApi, ApiError, errorMessage } from "../src/api";

let server: Server | undefined;
async function serve(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  server = undefined;
});

describe("console HTTP boundary", () => {
  it("confirms the saved proposal through the local CSRF boundary using only source and checksum", async () => {
    let received: unknown;
    const base = await serve(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = {
        path: req.url,
        csrf: req.headers["x-titan-csrf"],
        body: JSON.parse(Buffer.concat(chunks).toString()),
      };
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        '{"task":{"id":"task-1"},"artifact":{"artifactId":"artifact-1"}}',
      );
    });
    const input = {
      turnId: "11111111-1111-4111-8111-111111111111",
      proposalChecksum: `sha256:${"a".repeat(64)}`,
      confirmed: true as const,
    };
    await createConsoleApi(base).acceptWorkProposal(
      "project-1",
      input,
      "local-csrf",
    );
    expect(received).toEqual({
      path: "/local-api/projects/project-1/conversation/accept",
      csrf: "local-csrf",
      body: input,
    });
  });
  it("does not expose server error bodies through shared execution and settings APIs", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "INTERNAL_ERROR",
            message: "/private/secret-example failed",
          },
        }),
      );
    });
    let failure: unknown;
    try {
      await createConsoleApi(base).controlRun("run-1", "cancel");
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toBeInstanceOf(ApiError);
    expect(String(failure)).not.toContain("secret-example");
    expect(errorMessage(failure)).not.toContain("/private/");
    expect(errorMessage(new Error("secret-example"))).not.toContain(
      "secret-example",
    );
  });
  it("surfaces a stale task version as a refreshable conflict instead of reporting success", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "VERSION_CONFLICT", message: "task version changed" },
        }),
      );
    });
    const result = createConsoleApi(base).advanceStage("task-1", "research", 2);
    await expect(result).rejects.toMatchObject({
      status: 409,
      code: "VERSION_CONFLICT",
    });
  });

  it("passes CSRF only to local mutation and never includes a credential in surfaced errors", async () => {
    let received: { path?: string; csrf?: string; body?: unknown } = {};
    const base = await serve(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = {
        path: req.url,
        csrf: req.headers["x-titan-csrf"] as string,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      };
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "failed with secret-example" }));
    });
    let error: unknown;
    try {
      await createConsoleApi(base).saveCredential(
        "qwen",
        "secret-example",
        "csrf-test",
      );
    } catch (caught) {
      error = caught;
    }
    expect(received).toEqual({
      path: "/local-api/credentials",
      csrf: "csrf-test",
      body: { provider: "qwen", key: "secret-example" },
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(String(error)).not.toContain("secret-example");
  });

  it("sends artifact idempotency in the header without violating the strict artifact body", async () => {
    let received: unknown;
    const base = await serve(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = {
        key: req.headers["idempotency-key"],
        body: JSON.parse(Buffer.concat(chunks).toString()),
      };
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end('{"artifactId":"artifact-1"}');
    });
    await createConsoleApi(base).createArtifact(
      "task-1",
      "research",
      "# Research",
      ["questions-1"],
      "write-1",
    );
    expect(received).toEqual({
      key: "write-1",
      body: {
        type: "research",
        content: "# Research",
        sourceArtifacts: ["questions-1"],
      },
    });
  });

  it("reads split SSE frames and named events without losing the final buffered frame", async () => {
    const events: unknown[] = [];
    const base = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        ': keepalive\r\n\r\nevent: run.progressed\r\ndata: {"eventId":"e1",',
      );
      res.write('"sequence":1,"eventType":"run.progressed"}\r\n\r\n');
      res.end(
        'data: {"eventId":"e2","sequence":2,"eventType":"run.completed"}\n\n',
      );
    });
    await createConsoleApi(base).streamEvents(
      "run-1",
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(events).toEqual([
      { eventId: "e1", sequence: 1, eventType: "run.progressed" },
      { eventId: "e2", sequence: 2, eventType: "run.completed" },
    ]);
  });

  it("rejects HTML gateway errors with an actionable message and supports cancellation", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(502);
      res.end("<html>gateway unavailable</html>");
    });
    await expect(createConsoleApi(base).state()).rejects.toMatchObject({
      status: 502,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      createConsoleApi(base).state(controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces an SSE sequence gap so the subscriber can restart replay from the beginning", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        'event: stream.error\ndata: {"code":"EVENT_SEQUENCE_GAP","message":"Event sequence gap detected"}\n\n',
      );
    });
    await expect(
      createConsoleApi(base).streamEvents(
        "run-1",
        () => undefined,
        new AbortController().signal,
        42,
      ),
    ).rejects.toMatchObject({ code: "EVENT_SEQUENCE_GAP" });
  });
});
