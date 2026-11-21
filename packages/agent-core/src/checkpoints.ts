import { DomainError } from '@titan/contracts';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionCheckpoint } from './types.js';

export type Checkpoint = ExecutionCheckpoint & {
  runId?: string;
  successfulToolUseIds?: string[];
};

function normalize(checkpoint: Checkpoint): ExecutionCheckpoint {
  validateCheckpointId(checkpoint.id);
  return {
    id: checkpoint.id,
    messages: checkpoint.messages ?? [],
    successfulTools: checkpoint.successfulTools ?? (checkpoint.successfulToolUseIds ?? []).map(id => ({ id, name: 'unknown', inputHash: '', output: undefined })),
    evidence: checkpoint.evidence ?? [],
  };
}

function validateCheckpointId(id: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new DomainError('TOOL_INPUT_INVALID', 'checkpoint id contains unsupported characters');
}

export class CheckpointStore {
  protected readonly checkpoints = new Map<string, ExecutionCheckpoint>();

  async save(checkpoint: Checkpoint): Promise<Checkpoint> {
    const normalized = normalize(checkpoint);
    this.checkpoints.set(normalized.id, normalized);
    return normalized;
  }

  async get(id: string): Promise<ExecutionCheckpoint> {
    const checkpoint = this.checkpoints.get(id);
    if (!checkpoint) throw new DomainError('CHECKPOINT_NOT_FOUND', `checkpoint ${id} was not found`);
    return checkpoint;
  }

  async hydrate(checkpoint: ExecutionCheckpoint): Promise<ExecutionCheckpoint> {
    validateCheckpointId(checkpoint.id);
    this.checkpoints.set(checkpoint.id, checkpoint);
    return checkpoint;
  }
}

export class FileCheckpointStore extends CheckpointStore {
  constructor(private readonly root: string) { super(); }

  override async save(checkpoint: Checkpoint): Promise<ExecutionCheckpoint> {
    const normalized = normalize(checkpoint);
    await mkdir(this.root, { recursive: true });
    const temporary = join(this.root, `.${normalized.id}.${process.pid}.tmp`);
    const target = join(this.root, `${normalized.id}.json`);
    await writeFile(temporary, JSON.stringify(normalized), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
    return this.hydrate(normalized);
  }

  override async get(id: string): Promise<ExecutionCheckpoint> {
    validateCheckpointId(id);
    const cached = this.checkpoints.get(id);
    if (cached) return cached;
    try {
      const checkpoint = JSON.parse(await readFile(join(this.root, `${id}.json`), 'utf8')) as ExecutionCheckpoint;
      return this.hydrate(checkpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DomainError('CHECKPOINT_NOT_FOUND', `checkpoint ${id} was not found`);
      throw new DomainError('CHECKPOINT_NOT_FOUND', `checkpoint ${id} is invalid`);
    }
  }
}
