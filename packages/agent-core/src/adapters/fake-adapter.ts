import type { NativeSession, RuntimeAdapter, RuntimeEvent, RuntimeInput, RuntimeSessionConfig, CheckpointReference } from './runtime-adapter.js';

export class FakeAdapter implements RuntimeAdapter {
  constructor(private readonly events: RuntimeEvent[]) {}

  async createSession(config: RuntimeSessionConfig): Promise<NativeSession> {
    return { id: 'fake_session', runtime: config.runtime };
  }

  async *streamEvents(): AsyncIterable<RuntimeEvent> {
    yield* this.events;
  }

  async sendInput(): Promise<void> {}
  async pause(): Promise<CheckpointReference> { return { id: 'fake_checkpoint' }; }
  async resume(): Promise<void> {}
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}
