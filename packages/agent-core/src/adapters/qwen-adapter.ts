import { DomainError } from '@titan/contracts';
import type { CheckpointReference, NativeSession, RuntimeAdapter, RuntimeEvent, RuntimeInput, RuntimeSessionConfig } from './runtime-adapter.js';

export type QwenTransport = { send: (session: NativeSession) => AsyncIterable<{ type: string; payload?: unknown }> };

export class QwenAdapter implements RuntimeAdapter {
  constructor(private readonly transport: QwenTransport) {}

  async createSession(config: RuntimeSessionConfig): Promise<NativeSession> {
    if (!config.credentialRef) throw new DomainError('RUNTIME_ADAPTER_UNAVAILABLE', 'Qwen credential reference is required');
    return { id: `qwen:${config.modelRef ?? 'qwen-plus'}`, runtime: 'qwen' };
  }

  async *streamEvents(session: NativeSession): AsyncIterable<RuntimeEvent> {
    for await (const event of this.transport.send(session)) {
      if (event.type === 'done') yield { type: 'session.completed', payload: event.payload };
      else if (event.type === 'text') yield { type: 'text', payload: event.payload };
      else yield { type: 'model.streamed', payload: event.payload };
    }
  }

  async sendInput(): Promise<void> {}
  async pause(): Promise<CheckpointReference> { return { id: `qwen_checkpoint_${Date.now()}` }; }
  async resume(): Promise<void> {}
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}
