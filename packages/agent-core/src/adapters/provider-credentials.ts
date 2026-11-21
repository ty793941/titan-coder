import { DomainError } from '@titan/contracts';

export type ProviderCredentials = { apiKey: string | ((credentialRef: string) => string | Promise<string>) };

export function providerError(provider: string, reason: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError('RUNTIME_ADAPTER_UNAVAILABLE', `${provider}: ${reason}`, details);
}

export async function resolveApiKey(options: ProviderCredentials, credentialRef: string): Promise<string> {
  try {
    const key = typeof options.apiKey === 'function' ? await options.apiKey(credentialRef) : options.apiKey;
    if (typeof key !== 'string' || !key.trim()) throw new Error();
    return key;
  } catch {
    throw providerError('Provider', 'credential resolution failed');
  }
}
