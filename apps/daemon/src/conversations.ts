import { constants } from "node:fs";
import { rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { containsSensitive, ensureSafeDirectory } from "@titan/agent-core";
import {
  conversationContextSchema,
  conversationProjectIdSchema,
  conversationRequestSchema,
  conversationSnapshotSchema,
  workProposalSchema,
} from "@titan/contracts";
import type {
  ConversationContext,
  ConversationSnapshot,
  ConversationTurn,
} from "@titan/contracts";
import {
  runConversation,
  sanitizeConversation,
} from "../../agent-runtime/dist/conversation.js";
import type { ConversationInput } from "../../agent-runtime/dist/conversation.js";
import {
  resolveCredential,
  validateProviderBaseUrl,
} from "../../agent-runtime/dist/credentials.js";
import { openPrivateFile } from "./private-state.js";

type Options = {
  credentialResolver?: (reference: string) => Promise<string | undefined>;
  execute?: (input: ConversationInput, signal: AbortSignal) => Promise<string>;
  timeoutMs?: number;
};
type ActiveTurn = {
  id: string;
  controller: AbortController;
  done: Promise<void>;
  signal?: AbortSignal;
};

export class ConversationDaemon {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly active = new Map<string, ActiveTurn>();
  private closed = false;
  private admitting = 0;
  private ready: Promise<string> | undefined;
  private readonly shutdown = new AbortController();
  constructor(
    private readonly directory: string,
    private readonly options: Options = {},
  ) {}
  private initialize(): Promise<string> {
    return (this.ready ??= (async () => {
      await ensureSafeDirectory(this.directory, dirname(this.directory));
      return ensureSafeDirectory(
        join(this.directory, "sandbox"),
        this.directory,
      );
    })());
  }

  private async locked<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    conversationProjectIdSchema.parse(projectId);
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.locks.set(projectId, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(projectId) === next) this.locks.delete(projectId);
    }
  }
  private path(projectId: string) {
    return join(
      this.directory,
      `${createHash("sha256").update(projectId).digest("hex")}.json`,
    );
  }
  private async load(projectId: string): Promise<ConversationSnapshot> {
    await this.initialize();
    try {
      const file = await openPrivateFile(
        this.path(projectId),
        constants.O_RDONLY,
      );
      try {
        if ((await file.stat()).size > 4 * 1024 * 1024)
          throw new Error("CONVERSATION_HISTORY_INVALID");
        const result = conversationSnapshotSchema.parse(
          JSON.parse(await file.readFile("utf8")),
        );
        if (result.projectId !== projectId)
          throw new Error("CONVERSATION_HISTORY_INVALID");
        return result;
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { projectId, turns: [] };
      throw new Error("CONVERSATION_HISTORY_INVALID");
    }
  }
  private async save(snapshot: ConversationSnapshot): Promise<void> {
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const file = await openPrivateFile(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    );
    try {
      await file.writeFile(
        JSON.stringify(conversationSnapshotSchema.parse(snapshot)),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.path(snapshot.projectId));
  }
  private async recover(
    snapshot: ConversationSnapshot,
  ): Promise<ConversationSnapshot> {
    let changed = false;
    for (const turn of snapshot.turns) {
      if (
        turn.status === "running" &&
        this.active.get(snapshot.projectId)?.id !== turn.id
      ) {
        turn.status = "failed";
        turn.errorCode = "CONVERSATION_INTERRUPTED";
        turn.finishedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await this.save(snapshot);
    return snapshot;
  }
  async read(projectId: string): Promise<ConversationSnapshot> {
    return this.locked(projectId, async () =>
      this.recover(await this.load(projectId)),
    );
  }
  private resolveSecret(reference: string): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      const stop = () =>
        finish(undefined, new Error("CONVERSATION_UNAVAILABLE"));
      const timer = setTimeout(stop, 5000);
      const finish = (value?: string, error?: unknown) => {
        clearTimeout(timer);
        this.shutdown.signal.removeEventListener("abort", stop);
        if (error) reject(error);
        else resolve(value);
      };
      this.shutdown.signal.addEventListener("abort", stop, { once: true });
      if (this.shutdown.signal.aborted) {
        stop();
        return;
      }
      void Promise.resolve()
        .then(() =>
          (this.options.credentialResolver ?? resolveCredential)(reference),
        )
        .then(
          (value) => finish(value),
          () => finish(undefined),
        );
    });
  }
  async send(
    rawContext: ConversationContext,
    rawRequest: unknown,
    expiresAt = Date.now() + 10000,
  ): Promise<ConversationSnapshot> {
    const context = conversationContextSchema.parse(rawContext);
    const request = conversationRequestSchema.parse(rawRequest);
    return this.locked(context.projectId, async () => {
      if (this.closed) throw new Error("CONVERSATION_UNAVAILABLE");
      const snapshot = await this.recover(await this.load(context.projectId));
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(request))
        .digest("hex");
      const existing = snapshot.turns.find(
        (turn) => turn.requestId === request.requestId,
      );
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error("CONVERSATION_REQUEST_CONFLICT");
        return snapshot;
      }
      if (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt)
        throw new Error("CONVERSATION_UNAVAILABLE");
      if (
        this.active.has(context.projectId) ||
        this.active.size + this.admitting >= 2
      )
        throw new Error("CONVERSATION_BUSY");
      this.admitting++;
      try {
        const credential = await this.resolveSecret(
          request.provider === "codex"
            ? "keychain://titan-openai"
            : "keychain://titan-qwen",
        );
        const url =
          request.provider === "codex"
            ? await this.resolveSecret("keychain://titan-openai-base-url")
            : undefined;
        if (!credential || (request.provider === "codex" && !url))
          throw new Error("CONVERSATION_CREDENTIAL_REQUIRED");
        const baseUrl = url ? validateProviderBaseUrl(url) : undefined;
        const secrets = [credential, url, baseUrl].filter(
          (value): value is string => Boolean(value),
        );
        if (
          containsSensitive(request, secrets) ||
          /(?:https?|wss?):\/\//i.test(JSON.stringify(request))
        )
          throw new Error("CONVERSATION_SENSITIVE_INPUT");
        const sandbox = await this.initialize();
        if (this.closed) throw new Error("CONVERSATION_UNAVAILABLE");
        const turn: ConversationTurn = {
          id: randomUUID(),
          requestId: request.requestId,
          fingerprint,
          text: request.text,
          provider: request.provider,
          ...(request.mode ? { mode: request.mode } : {}),
          ...(request.modelRef ? { modelRef: request.modelRef } : {}),
          status: "running",
          createdAt: new Date().toISOString(),
        };
        const history = sanitizeConversation(
          snapshot.turns
            .filter((item) => item.status === "completed")
            .slice(-10)
            .map((item) => ({
              text: item.text,
              ...(item.reply ? { reply: item.reply } : {}),
            })),
          secrets,
        );
        snapshot.turns = [...snapshot.turns.slice(-39), turn];
        const controller = new AbortController();
        const active: ActiveTurn = {
          id: turn.id,
          controller,
          done: Promise.resolve(),
        };
        this.active.set(context.projectId, active);
        try {
          await this.save(snapshot);
        } catch (error) {
          this.active.delete(context.projectId);
          throw error;
        }
        if (this.closed || Date.now() >= expiresAt) {
          turn.status = "cancelled";
          turn.finishedAt = new Date().toISOString();
          try {
            await this.save(snapshot);
          } finally {
            this.active.delete(context.projectId);
          }
          return structuredClone(snapshot);
        }
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(this.options.timeoutMs ?? 120000),
        ]);
        active.signal = signal;
        active.done = this.execute(
          {
            text: request.text,
            provider: request.provider,
            ...(request.mode ? { mode: request.mode } : {}),
            ...(request.modelRef ? { modelRef: request.modelRef } : {}),
            context: sanitizeConversation(context, secrets),
            history,
            credential,
            ...(baseUrl ? { baseUrl } : {}),
            sandbox,
          },
          signal,
        )
          .then((reply) => {
            if (request.mode === "work-proposal") {
              try {
                if (reply.length > 32000 || containsSensitive(reply, secrets) || /(?:https?|wss?):\/\//i.test(reply)) throw new Error();
                const proposal = workProposalSchema.parse(JSON.parse(reply));
                if (containsSensitive(proposal, secrets)) throw new Error();
                const proposalChecksum = `sha256:${createHash("sha256").update(JSON.stringify(proposal)).digest("hex")}`;
                return this.finish(context.projectId, turn.id, { status: "completed", proposal, proposalChecksum, reply: `已生成工作提案：${proposal.title}。确认后创建任务与待审批问题确认草稿。` });
              } catch { throw new Error("CONVERSATION_PROPOSAL_INVALID"); }
            }
            return this.finish(context.projectId, turn.id, {
              status: "completed",
              reply: sanitizeConversation(reply, secrets).slice(0, 16000),
            });
          })
          .catch((error) =>
            this.finish(context.projectId, turn.id, {
              status: controller.signal.aborted ? "cancelled" : "failed",
              ...(controller.signal.aborted
                ? {}
                : {
                    errorCode: signal.aborted
                      ? "CONVERSATION_TIMEOUT"
                      : error instanceof Error && error.message === "CONVERSATION_PROPOSAL_INVALID"
                        ? "CONVERSATION_PROPOSAL_INVALID"
                        : error instanceof Error &&
                          error.message === "CONVERSATION_READ_ONLY"
                        ? "CONVERSATION_READ_ONLY"
                        : "CONVERSATION_FAILED",
                  }),
            }),
          )
          .finally(() => {
            if (this.active.get(context.projectId) === active)
              this.active.delete(context.projectId);
          });
        void active.done.catch(() => undefined);
        return structuredClone(snapshot);
      } finally {
        this.admitting--;
      }
    });
  }
  private async execute(
    input: ConversationInput,
    signal: AbortSignal,
  ): Promise<string> {
    const reply = await (this.options.execute
      ? this.options.execute(input, signal)
      : runConversation(input, undefined, signal));
    signal.throwIfAborted();
    return reply;
  }
  private async finish(
    projectId: string,
    turnId: string,
    result: Pick<ConversationTurn, "status" | "reply" | "errorCode" | "proposal" | "proposalChecksum">,
  ): Promise<void> {
    await this.locked(projectId, async () => {
      const snapshot = await this.load(projectId);
      const turn = snapshot.turns.find((item) => item.id === turnId);
      if (!turn || turn.status !== "running") return;
      const active = this.active.get(projectId);
      const interrupted = active?.id === turnId && active.signal?.aborted;
      const settled = interrupted
        ? active.controller.signal.aborted
          ? { status: "cancelled" as const }
          : { status: "failed" as const, errorCode: "CONVERSATION_TIMEOUT" as const }
        : result;
      Object.assign(turn, settled, { finishedAt: new Date().toISOString() });
      await this.save(snapshot);
    });
  }
  async cancel(
    projectId: string,
    turnId: string,
  ): Promise<ConversationSnapshot> {
    await this.locked(projectId, async () => {
      if (this.active.get(projectId)?.id === turnId)
        this.active.get(projectId)!.controller.abort();
    });
    return this.read(projectId);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.shutdown.abort();
    this.active.forEach((turn) => turn.controller.abort());
    await Promise.allSettled([...this.locks.values()]);
    const active = [...this.active.values()];
    active.forEach((turn) => turn.controller.abort());
    await Promise.allSettled(active.map((turn) => turn.done));
  }
}
