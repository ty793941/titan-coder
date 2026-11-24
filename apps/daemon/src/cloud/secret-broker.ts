import type { SecretLeaseInput } from './types.js';

export class SecretBroker {
  private readonly consumed = new Set<string>();

  constructor(private readonly resolver: (ref: string) => Promise<string | undefined>) {}

  async consume(input: SecretLeaseInput): Promise<Record<string, string>> {
    const { leaseId, sessionId, credentialRef, baseUrlRef } = input;
    const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
    const validRef = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\/[a-zA-Z0-9_./-]{1,500}$/.test(value) && !value.split('/').includes('..');
    if (!validId(leaseId) || !validId(sessionId) || !validRef(credentialRef) || (baseUrlRef !== undefined && !validRef(baseUrlRef))) throw new Error('CLOUD_SECRET_LEASE_INVALID');
    if (this.consumed.has(leaseId)) throw new Error('CLOUD_SECRET_CONSUMED');
    if (this.consumed.size >= 100_000) throw new Error('CLOUD_SECRET_CAPACITY');
    // 包括过期失败在内均保留墓碑，调用方不能修改 TTL 后复活同一租约。
    this.consumed.add(leaseId);
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('CLOUD_SECRET_LEASE_EXPIRED');
    // 消费是同步 CAS；失败、超时和跨 Session 重试均不能复用租约。
    const secrets: Record<string, string> = {};
    try {
      for (const ref of new Set([credentialRef, ...(baseUrlRef ? [baseUrlRef] : [])])) {
        if (expiresAt <= Date.now()) throw new Error('expired');
        const value = await this.resolver(ref);
        if (!value || typeof value !== 'string') throw new Error('missing');
        secrets[ref] = value;
      }
    } catch {
      if (expiresAt <= Date.now()) throw new Error('CLOUD_SECRET_LEASE_EXPIRED');
      throw new Error('CLOUD_SECRET_RESOLUTION_FAILED');
    }
    if (expiresAt <= Date.now()) throw new Error('CLOUD_SECRET_LEASE_EXPIRED');
    return secrets;
  }
}
