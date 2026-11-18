import { DomainError } from '@titan/contracts';

export type Checkpoint = {
  id: string;
  runId: string;
  successfulToolUseIds: string[];
  evidence: { kind: string; reference: string }[];
};

export class CheckpointStore {
  private readonly checkpoints = new Map<string, Checkpoint>();

  async save(checkpoint: Checkpoint): Promise<Checkpoint> {
    this.checkpoints.set(checkpoint.id, checkpoint);
    return checkpoint;
  }

  async get(id: string): Promise<Checkpoint> {
    const checkpoint = this.checkpoints.get(id);
    if (!checkpoint) throw new DomainError('CHECKPOINT_NOT_FOUND', `checkpoint ${id} was not found`);
    return checkpoint;
  }
}
