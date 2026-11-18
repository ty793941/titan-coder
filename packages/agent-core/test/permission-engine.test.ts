import { describe, expect, it } from 'vitest';
import { PermissionEngine } from '../src/permission-engine.js';

describe('PermissionEngine', () => {
  it('denies an action when any policy layer explicitly denies it', () => {
    const engine = new PermissionEngine([
      { source: 'platform', action: 'workspace.write', resource: '/repo', decision: 'allow' },
      { source: 'run', action: 'workspace.write', resource: '/repo', decision: 'deny' },
    ]);

    expect(engine.decide({ action: 'workspace.write', resource: '/repo/a.ts' }).decision).toBe('deny');
  });

  it('returns ask for an explicitly gated action', () => {
    const engine = new PermissionEngine([
      { source: 'project', action: 'release.execute', resource: 'staging', decision: 'ask' },
    ]);

    expect(engine.decide({ action: 'release.execute', resource: 'staging' }).decision).toBe('ask');
  });
});
