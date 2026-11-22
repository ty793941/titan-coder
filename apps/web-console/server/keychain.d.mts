export const providers: Record<'codex' | 'qwen', { service: string; credentialRef: string }>;
export class KeychainStore {
  constructor(platform?: string, run?: unknown, launch?: unknown);
  configured(provider: string): Promise<boolean>;
  save(provider: string, key: string): Promise<void>;
}
