import type { ConversationSnapshot } from '@titan/contracts';

export class ConversationHost {
  constructor(root: string);
  request(operation: string, projectId: string, input?: unknown, context?: unknown): Promise<ConversationSnapshot>;
  close(): Promise<void>;
}
