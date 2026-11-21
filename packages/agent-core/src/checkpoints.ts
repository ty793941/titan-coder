import { DomainError } from '@titan/contracts';
import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionCheckpoint } from './types.js';
import { ensureSafeDirectory, sanitizeSensitive } from './security.js';

const MAX_CHECKPOINT_BYTES = 1024 * 1024;

export type Checkpoint = ExecutionCheckpoint & {
  runId?: string;
  successfulToolUseIds?: string[];
};

function normalize(checkpoint: Checkpoint, secretValues: string[] = []): ExecutionCheckpoint {
  if (!checkpoint || typeof checkpoint.id !== 'string') throw new DomainError('TOOL_INPUT_INVALID', 'checkpoint id is required');
  if (!/^[A-Za-z0-9._-]+$/.test(checkpoint.id)) throw new DomainError('TOOL_INPUT_INVALID', 'checkpoint id contains unsupported characters');
  const normalized: ExecutionCheckpoint = {
    id: checkpoint.id,
    messages: sanitizeSensitive(checkpoint.messages ?? [], secretValues),
    successfulTools: sanitizeSensitive(checkpoint.successfulTools ?? (checkpoint.successfulToolUseIds ?? []).map(id => ({ id, name: 'unknown', inputHash: '', output: undefined })), secretValues),
    evidence: sanitizeSensitive(checkpoint.evidence ?? [], secretValues),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_CHECKPOINT_BYTES) throw new DomainError('TOOL_INPUT_INVALID', 'checkpoint exceeds 1 MiB');
  return normalized;
}

export class CheckpointStore {
  protected readonly checkpoints = new Map<string, ExecutionCheckpoint>();
  constructor(protected readonly secretValues: string[] = []) {}

  async save(checkpoint: Checkpoint): Promise<ExecutionCheckpoint> {
    const normalized = normalize(checkpoint, this.secretValues);
    this.checkpoints.set(normalized.id, normalized);
    return normalized;
  }

  async get(id: string): Promise<ExecutionCheckpoint> {
    const checkpoint = this.checkpoints.get(id);
    if (!checkpoint) throw new DomainError('CHECKPOINT_NOT_FOUND', `checkpoint ${id} was not found`);
    return checkpoint;
  }

  async hydrate(checkpoint: ExecutionCheckpoint): Promise<ExecutionCheckpoint> {
    const normalized = normalize(checkpoint, this.secretValues);
    this.checkpoints.set(normalized.id, normalized);
    return normalized;
  }
}

export class FileCheckpointStore extends CheckpointStore {
  private rootPromise: Promise<string> | undefined;
  constructor(private readonly root: string, private readonly workspacePath?: string, secretValues: string[] = []) {
    super(secretValues);
  }

  override async save(checkpoint: Checkpoint): Promise<ExecutionCheckpoint> {
    const normalized = normalize(checkpoint, this.secretValues);
    const root = await this.rootDirectory();
    const temporary = join(root, `.${normalized.id}.${process.pid}.tmp`);
    const target = join(root, `${normalized.id}.json`);
    try {
      const existing = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (existing?.isSymbolicLink()) throw new DomainError('TOOL_INPUT_INVALID', 'checkpoint target cannot be a symlink');
      await writeFile(temporary, JSON.stringify(normalized), { encoding: 'utf8', mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error instanceof DomainError ? error : new DomainError('TOOL_EXECUTION_FAILED', 'checkpoint could not be persisted', { cause: String(error) });
    }
    return this.hydrate(normalized);
  }

  override async get(id: string): Promise<ExecutionCheckpoint> {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new DomainError('TOOL_INPUT_INVALID', 'checkpoint id contains unsupported characters');
    const cached = this.checkpoints.get(id);
    if (cached) return cached;
    try {
      const root = await this.rootDirectory();
      const checkpoint = JSON.parse(await readFile(join(root, `${id}.json`), 'utf8')) as ExecutionCheckpoint;
      return this.hydrate(checkpoint);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DomainError('CHECKPOINT_NOT_FOUND', `checkpoint ${id} was not found`);
      throw new DomainError('CHECKPOINT_NOT_FOUND', `checkpoint ${id} is invalid`);
    }
  }

  private async rootDirectory(): Promise<string> {
    this.rootPromise ??= ensureSafeDirectory(this.root, this.workspacePath);
    return this.rootPromise;
  }
}
