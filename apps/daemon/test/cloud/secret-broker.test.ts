import { describe, expect, it } from 'vitest';
import { SecretBroker } from '../../src/cloud/secret-broker.js';

const lease = () => ({ leaseId: 'lease-1', sessionId: 'session-1', expiresAt: new Date(Date.now() + 60_000).toISOString(), credentialRef: 'keychain://provider', baseUrlRef: 'keychain://url' });

describe('SecretBroker', () => {
  it('resolves references only into an in-memory mapping', async () => {
    const broker = new SecretBroker(async ref => ref.endsWith('url') ? 'https://provider.example/v1' : 'private-value');
    expect(await broker.consume(lease())).toEqual({ 'keychain://provider': 'private-value', 'keychain://url': 'https://provider.example/v1' });
  });

  it('consumes synchronously before resolving and refuses another session', async () => {
    let complete!: (value: string) => void;
    const broker = new SecretBroker(() => new Promise(resolve => { complete = resolve; }));
    const input = { ...lease(), baseUrlRef: undefined };
    const pending = broker.consume(input);
    await expect(broker.consume(input)).rejects.toThrow('CLOUD_SECRET_CONSUMED');
    await expect(broker.consume({ ...input, sessionId: 'other' })).rejects.toThrow('CLOUD_SECRET_CONSUMED');
    complete('private-value');
    await pending;
  });

  it('burns failed resolutions without exposing resolver errors', async () => {
    const broker = new SecretBroker(async () => { throw new Error('sk-super-secret-material'); });
    await expect(broker.consume(lease())).rejects.toThrow(/^CLOUD_SECRET_RESOLUTION_FAILED$/);
    await expect(broker.consume(lease())).rejects.toThrow('CLOUD_SECRET_CONSUMED');
  });

  it('rejects expired or malformed leases without resolving secrets', async () => {
    let calls = 0;
    const broker = new SecretBroker(async () => { calls++; return 'value'; });
    for (const expiresAt of ['invalid', new Date(Date.now() - 1).toISOString()]) {
      await expect(broker.consume({ ...lease(), leaseId: expiresAt === 'invalid' ? 'bad' : 'expired', expiresAt })).rejects.toThrow('CLOUD_SECRET_LEASE_EXPIRED');
    }
    await expect(broker.consume({ ...lease(), sessionId: '' })).rejects.toThrow('CLOUD_SECRET_LEASE_INVALID');
    expect(calls).toBe(0);
  });

  it('does not release missing or expired-during-resolution leases for reuse', async () => {
    const broker = new SecretBroker(async () => undefined);
    await expect(broker.consume(lease())).rejects.toThrow('CLOUD_SECRET_RESOLUTION_FAILED');
    await expect(broker.consume(lease())).rejects.toThrow('CLOUD_SECRET_CONSUMED');
    let finish!: (value: string) => void;
    const slow = new SecretBroker(() => new Promise(resolve => { finish = resolve; }));
    const input = { ...lease(), expiresAt: new Date(Date.now() + 10).toISOString(), baseUrlRef: undefined };
    const pending = slow.consume(input);
    await new Promise(resolve => setTimeout(resolve, 20));
    finish('value');
    await expect(pending).rejects.toThrow('CLOUD_SECRET_LEASE_EXPIRED');
  });

  it('does not revive an expired lease by supplying a later TTL', async () => {
    const broker = new SecretBroker(async () => 'value');
    await expect(broker.consume({ ...lease(), expiresAt: new Date(0).toISOString() })).rejects.toThrow('CLOUD_SECRET_LEASE_EXPIRED');
    await expect(broker.consume(lease())).rejects.toThrow('CLOUD_SECRET_CONSUMED');
  });

  it('fails closed at a bounded tombstone capacity rather than forgetting consumed leases', async () => {
    const broker = new SecretBroker(async () => 'value');
    for (let index = 0; index < 100_000; index++) {
      await broker.consume({ ...lease(), leaseId: `lease-${index}`, expiresAt: new Date(0).toISOString() }).catch(() => {});
    }
    await expect(broker.consume({ ...lease(), leaseId: 'new-lease' })).rejects.toThrow('CLOUD_SECRET_CAPACITY');
    await expect(broker.consume({ ...lease(), leaseId: 'lease-0' })).rejects.toThrow('CLOUD_SECRET_CONSUMED');
  }, 10_000);
});
