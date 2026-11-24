import type { Readable, Writable } from 'node:stream';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { executionCheckpointSchema, executionConfigSchema } from '@titan/contracts';
import type { AgentRunResult } from '@titan/agent-core';
import type { RunDispatch } from '@titan/daemon-protocol';
import { executeDispatch } from './worker.js';

const MAX_BOOTSTRAP_BYTES = 2 * 1024 * 1024;
const identifier = z.string().min(1).max(200);
const bootstrapSchema = z.object({
  version: z.literal(1),
  dispatch: z.object({
    jobId: identifier, runId: identifier, sessionId: identifier, taskId: identifier, projectId: identifier,
    goal: z.string().min(1).max(1024 * 1024), planHash: identifier, claimToken: identifier,
    config: executionConfigSchema.extend({
      localPolicy: z.object({ enabledSkills: z.array(identifier).max(64).optional(), trustedCode: z.boolean().optional() }).strict().optional(),
    }).refine(config => isAbsolute(config.workspacePath) && !config.workspacePath.includes('\0')),
    checkpoint: executionCheckpointSchema.optional(),
  }).strict(),
  credentials: z.unknown(),
}).strict();

type ContainerWorkerOptions = {
  input: Readable;
  output: Writable;
  execute?: typeof executeDispatch;
};

async function readBootstrap(input: Readable): Promise<z.infer<typeof bootstrapSchema>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // EOF 确认输入只有一帧；它结束凭证注入，不代表取消后续执行。
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BOOTSTRAP_BYTES) throw new Error('INVALID_CONTAINER_BOOTSTRAP');
    chunks.push(buffer);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const lines = text.split('\n');
  if (lines.length !== 2 || lines[1] !== '' || !lines[0]?.trim()) throw new Error('INVALID_CONTAINER_BOOTSTRAP');
  return bootstrapSchema.parse(JSON.parse(lines[0]));
}

function memoryCredentials(bootstrap: z.infer<typeof bootstrapSchema>): Map<string, string> {
  const allowed = new Set([bootstrap.dispatch.config.credentialRef, bootstrap.dispatch.config.baseUrlRef].filter(Boolean));
  const credentials = bootstrap.credentials;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('INVALID_CONTAINER_BOOTSTRAP');
  const values = new Map<string, string>();
  for (const [reference, value] of Object.entries(credentials)) {
    if (!allowed.has(reference) || typeof value !== 'string' || !value) throw new Error('INVALID_CONTAINER_BOOTSTRAP');
    values.set(reference, value);
  }
  return values;
}

export async function runContainerWorker({ input, output, execute = executeDispatch }: ContainerWorkerOptions): Promise<AgentRunResult['status']> {
  const controller = new AbortController();
  let credentials = new Map<string, string>();
  let writes = Promise.resolve();
  let outputFailed = false;
  const terminate = () => {
    controller.abort();
    if (!input.readableEnded) input.destroy(new Error('CONTAINER_WORKER_CANCELLED'));
  };
  const outputError = () => { outputFailed = true; controller.abort(); };
  const writeFrame = (frame: unknown): Promise<void> => new Promise((resolve, reject) => {
    if (outputFailed || output.destroyed) { reject(new Error('CONTAINER_OUTPUT_UNAVAILABLE')); return; }
    output.write(`${JSON.stringify(frame)}\n`, error => error ? reject(error) : resolve());
  });
  process.on('SIGTERM', terminate);
  output.on('error', outputError);
  try {
    const bootstrap = await readBootstrap(input);
    credentials = memoryCredentials(bootstrap);
    const result = await execute(bootstrap.dispatch as RunDispatch, {
      credentialResolver: async reference => credentials.get(reference),
      signal: controller.signal,
      sendProgress: progress => {
        const safeProgress = progress.type === 'failed' ? {
          ...progress, payload: { code: 'CONTAINER_RUNTIME_FAILED', message: 'Container runtime failed' },
        } : progress;
        writes = writes.then(() => writeFrame({ version: 1, type: 'progress', progress: safeProgress }));
        void writes.catch(outputError);
      },
    });
    await writes;
    await writeFrame({ version: 1, type: 'result', status: result.status });
    return result.status;
  } catch {
    const status = controller.signal.aborted && !outputFailed ? 'cancelled' : 'failed';
    await writes.catch(() => undefined);
    await writeFrame({ version: 1, type: 'result', status }).catch(() => undefined);
    return status;
  } finally {
    credentials.clear();
    process.off('SIGTERM', terminate);
    output.off('error', outputError);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runContainerWorker({ input: process.stdin, output: process.stdout }).then(status => {
    if (status === 'failed') process.exitCode = 1;
  });
}
