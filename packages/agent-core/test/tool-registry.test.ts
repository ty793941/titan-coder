import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HookRunner } from '../src/hook-runner.js';
import { PermissionEngine } from '../src/permission-engine.js';
import { ToolRegistry } from '../src/tool-registry.js';

describe('ToolRegistry', () => {
  it('runs permission and pre/post hooks around a tool exactly once', async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry({
      permission: new PermissionEngine([{ source: 'run', action: 'test.echo', resource: 'run_1', decision: 'allow' }]),
      hooks: new HookRunner([
        { name: 'pre', phase: 'before', priority: 1, run: async () => { calls.push('pre'); return 'allow'; } },
        { name: 'post', phase: 'after', priority: 1, run: async () => { calls.push('post'); return 'allow'; } },
      ]),
      onAudit: event => { if (event.status === 'success') calls.push('audit'); },
    });
    registry.register({
      name: 'test.echo', version: 1, input: z.object({ value: z.string() }),
      execute: async input => { calls.push('execute'); return input; },
    });

    await registry.execute({ toolUseId: 'tool_1', name: 'test.echo', input: { value: 'ok' }, context: { runId: 'run_1' } });
    await registry.execute({ toolUseId: 'tool_1', name: 'test.echo', input: { value: 'ok' }, context: { runId: 'run_1' } });
    expect(calls).toEqual(['pre', 'execute', 'post', 'audit']);
  });
});
