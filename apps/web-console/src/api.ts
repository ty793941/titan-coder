import type {
  Artifact,
  ArtifactContent,
  ConsoleState,
  LocalStatus,
  Priority,
  Project,
  Provider,
  Run,
  RunEvent,
  Session,
  SessionInput,
  Stage,
  Task,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export const newRequestKey = (): string => crypto.randomUUID();
const id = encodeURIComponent;

export function createConsoleApi(base = "") {
  async function request<T>(
    path: string,
    init: RequestInit = {},
    sensitive = false,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, { ...init, cache: "no-store" });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError(
        0,
        "NETWORK_UNAVAILABLE",
        "无法连接本机网关，请确认服务已经启动。",
      );
    }
    if (response.status === 204) return undefined as T;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const record =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      const error =
        record.error && typeof record.error === "object"
          ? (record.error as Record<string, unknown>)
          : record;
      const code =
        typeof error.code === "string" && !sensitive
          ? error.code
          : `HTTP_${response.status}`;
      const message = sensitive
        ? "凭证保存失败，请检查本机密钥链权限后重试。"
        : typeof error.message === "string"
          ? error.message
          : `请求失败（HTTP ${response.status}），请检查本机服务。`;
      throw new ApiError(response.status, code, message);
    }
    if (body === null)
      throw new ApiError(
        response.status,
        "INVALID_RESPONSE",
        "网关未返回有效 JSON，请检查服务地址。",
      );
    return body as T;
  }
  function post<T>(path: string, body: unknown, key?: string) {
    return request<T>(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    });
  }
  function localPost<T>(
    path: string,
    body: unknown,
    csrfToken: string,
    sensitive = false,
  ) {
    if (!csrfToken)
      return Promise.reject(
        new ApiError(
          403,
          "CSRF_UNAVAILABLE",
          "本机安全令牌尚未就绪，请刷新环境状态。",
        ),
      );
    return request<T>(
      `/local-api${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Titan-CSRF": csrfToken,
        },
        body: JSON.stringify(body),
      },
      sensitive,
    );
  }
  return {
    state: (signal?: AbortSignal) =>
      request<ConsoleState>("/api/console/state", { signal }),
    localStatus: (signal?: AbortSignal) =>
      request<LocalStatus>("/local-api/status", { signal }),
    artifacts: (taskId: string, signal?: AbortSignal) =>
      request<Artifact[]>(`/api/tasks/${id(taskId)}/artifacts`, { signal }),
    content: (artifactId: string, signal?: AbortSignal) =>
      request<ArtifactContent>(`/api/artifacts/${id(artifactId)}/content`, {
        signal,
      }),
    createProject(name: string, goal: string, key = newRequestKey()) {
      return post<Project>(
        "/api/projects",
        { name, goal, idempotencyKey: key },
        key,
      );
    },
    createTask(
      projectId: string,
      input: {
        title: string;
        goal: string;
        acceptanceCriteria: string[];
        priority: Priority;
      },
      key = newRequestKey(),
    ) {
      return post<Task>(
        `/api/projects/${id(projectId)}/tasks`,
        { ...input, idempotencyKey: key },
        key,
      );
    },
    createArtifact(
      taskId: string,
      type: string,
      content: string,
      sourceArtifacts: string[],
      key = newRequestKey(),
    ) {
      return post<Artifact>(
        `/api/tasks/${id(taskId)}/artifacts`,
        { type, content, sourceArtifacts },
        key,
      );
    },
    approveArtifact: (artifactId: string) =>
      post<Artifact>(`/api/artifacts/${id(artifactId)}/approve`, {}),
    advanceStage: (taskId: string, stage: Stage, expectedVersion: number) =>
      post<Task>(`/api/tasks/${id(taskId)}/stage`, { stage, expectedVersion }),
    createSession: (taskId: string, input: SessionInput) =>
      post<Session>(
        `/api/tasks/${id(taskId)}/sessions`,
        input,
        input.idempotencyKey,
      ),
    createRun(sessionId: string, key = newRequestKey()) {
      return post<Run>(
        `/api/sessions/${id(sessionId)}/runs`,
        { idempotencyKey: key },
        key,
      );
    },
    controlRun(
      runId: string,
      action: "pause" | "resume" | "cancel",
      key = newRequestKey(),
    ) {
      return post<Run>(
        `/api/runs/${id(runId)}/${action}`,
        action === "resume" ? { idempotencyKey: key } : {},
        key,
      );
    },
    saveCredential: (provider: Provider, key: string, csrfToken: string) =>
      localPost<{ configured: boolean; credentialRef: string }>(
        "/credentials",
        { provider, key },
        csrfToken,
        true,
      ),
    daemon: (action: "start" | "stop", csrfToken: string) =>
      localPost<{ running: boolean; daemonId?: string }>(
        `/daemon/${action}`,
        {},
        csrfToken,
      ),
    async streamEvents(
      runId: string,
      onEvent: (event: RunEvent) => void,
      signal: AbortSignal,
      after?: number,
    ) {
      const query = new URLSearchParams({
        follow: "true",
        ...(after ? { after: String(after) } : {}),
      });
      const response = await fetch(
        `${base}/api/runs/${id(runId)}/events?${query}`,
        {
          signal,
          headers: {
            Accept: "text/event-stream",
            ...(after ? { "Last-Event-ID": String(after) } : {}),
          },
          cache: "no-store",
        },
      );
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      )
        throw new ApiError(
          response.status,
          "EVENT_STREAM_UNAVAILABLE",
          "事件订阅暂不可用，正在等待重新连接。",
        );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            if (!data || data === "[DONE]") continue;
            const event: unknown = JSON.parse(data);
            if (
              frame
                .split(/\r?\n/)
                .some((line) => /^event:\s*stream\.error\s*$/.test(line))
            ) {
              const failure =
                event && typeof event === "object"
                  ? (event as Record<string, unknown>)
                  : {};
              throw new ApiError(
                200,
                typeof failure.code === "string"
                  ? failure.code
                  : "EVENT_STREAM_ERROR",
                "事件订阅中断，正在重新同步运行记录。",
              );
            }
            if (
              event &&
              typeof event === "object" &&
              "eventId" in event &&
              "eventType" in event &&
              "sequence" in event
            )
              onEvent(event as RunEvent);
          }
          if (done) break;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  };
}
export const api = createConsoleApi();
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请刷新后重试。";
}
