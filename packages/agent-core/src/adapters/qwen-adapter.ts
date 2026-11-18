import { DomainError } from '@titan/contracts';
import type { CheckpointReference, NativeSession, RuntimeAdapter, RuntimeEvent, RuntimeInput, RuntimeSessionConfig } from './runtime-adapter.js';

type QwenTransport = { send: (session: NativeSession) => AsyncIterable<{ type: string; payload?: unknown }> };

export class QwenAdapter implements RuntimeAdapter {
  constructor(private readonly transport: QwenTransport) {}

  async createSession(config: RuntimeSessionConfig): Promise<NativeSession> {
    if (!config.credentialRef) throw new DomainError('RUNTIME_ADAPTER_UNAVAILABLE', 'Qwen credential reference is required');
    return { id: `qwen_${Date.now()}`, runtime: 'qwen' };
  }

  async *streamEvents(session: NativeSession): AsyncIterable<RuntimeEvent> {
    for await (const event of this.transport.send(session)) {
      yield event.type === 'done' ? { type: 'session.completed', payload: event.payload } : { type: 'model.streamed', payload: event.payload };
    }
  }

  async sendInput(): Promise<void> {}
  async pause(): Promise<CheckpointReference> { return { id: `qwen_checkpoint_${Date.now()}` }; }
  async resume(): Promise<void> {}
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}
