import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { TEMPORAL_NAMESPACE, TEMPORAL_TASK_QUEUE } from '@titan/workflow';

const configSchema = z.object({
  temporalAddress: z.string().min(1).max(255).regex(/^[A-Za-z0-9_.:[\]-]+$/),
  namespace: z.string().min(1).max(100).default(TEMPORAL_NAMESPACE),
  taskQueue: z.literal(TEMPORAL_TASK_QUEUE).default(TEMPORAL_TASK_QUEUE),
  controlPlaneUrl: z.string().min(1).max(500),
  workerId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  credentialRef: z.union([
    z.string().regex(/^keychain:\/\/[A-Za-z0-9_-]{1,200}$/),
    z.literal('stdin://workflow'),
  ]),
  pollIntervalMs: z.number().int().min(1).max(60_000).default(1_000),
  requestTimeoutMs: z.number().int().min(1).max(120_000).default(5_000),
}).strict();

export type WorkerConfig = z.infer<typeof configSchema>;

export async function loadWorkerConfig(argv: string[]): Promise<WorkerConfig> {
  if (argv.length !== 2 || argv[0] !== '--config' || !argv[1]) throw new Error('WORKFLOW_CONFIG_INVALID');
  try {
    const raw = await readFile(resolve(argv[1]), { encoding: 'utf8' });
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error();
    return configSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('WORKFLOW_CONFIG_INVALID');
  }
}
