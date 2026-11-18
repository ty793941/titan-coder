import { DomainError } from '@titan/contracts';
import type { CheckpointReference, NativeSession, RuntimeAdapter, RuntimeEvent, RuntimeInput, RuntimeSessionConfig } from './runtime-adapter.js';

type CodexTransport = {
  create: (config: RuntimeSessionConfig) => Promise<{ id: string }>;
  events: (session: { id: string }) => AsyncIterable<{ type: string; payload?: unknown }>;
  send: (session: { id: string }, input: RuntimeInput) => Promise<void>;
  pause: (session: { id: string }) => Promise<CheckpointReference>;
  resume: (session: { id: string }, checkpoint: CheckpointReference) => Promise<void>;
  cancel: (session: { id: string }) => Promise<void>;
  close: (session: { id: string }) => Promise<void>;
};

export class CodexAdapter implements RuntimeAdapter {
  constructor(private readonly transport: CodexTransport) {}

  async createSession(config: RuntimeSessionConfig): Promise<NativeSession> {
    if (!config.credentialRef) throw new DomainError('RUNTIME_ADAPTER_UNAVAILABLE', 'Codex credential reference is required');
    const session = await this.transport.create(config);
    return { id: session.id, runtime: 'codex' };
  }

  async *streamEvents(session: NativeSession): AsyncIterable<RuntimeEvent> {
    for await (const event of this.transport.events(session)) {
      if (event.type === 'turn.started') yield { type: 'session.started', payload: event.payload };
      else if (event.type === 'turn.completed') yield { type: 'session.completed', payload: event.payload };
      else yield { type: 'model.streamed', payload: event.payload };
    }
  }

  sendInput(session: NativeSession, input: RuntimeInput): Promise<void> { return this.transport.send(session, input); }
  pause(session: NativeSession): Promise<CheckpointReference> { return this.transport.pause(session); }
  resume(session: NativeSession, checkpoint: CheckpointReference): Promise<void> { return this.transport.resume(session, checkpoint); }
  cancel(session: NativeSession): Promise<void> { return this.transport.cancel(session); }
  close(session: NativeSession): Promise<void> { return this.transport.close(session); }
}
