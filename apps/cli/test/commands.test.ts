import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/main.js';

describe('CLI commands', () => {
  it('creates a task through the API and prints JSON when --json is set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'task_1', stage: 'questions' }), { status: 201, headers: { 'content-type': 'application/json' } })));
    const result = await runCli(['task', 'create', '--project', 'project_1', '--title', '首个任务', '--goal', '验证闭环', '--json']);
    expect(JSON.parse(result.stdout)).toMatchObject({ stage: 'questions' });
    expect(result.exitCode).toBe(0);
  });

  it('prints stable error code and nonzero exit code for API failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'RESOURCE_NOT_FOUND', message: 'missing' }), { status: 404, headers: { 'content-type': 'application/json' } })));
    const result = await runCli(['run', 'get', 'run_missing', '--json']);
    expect(result.stdout).toContain('RESOURCE_NOT_FOUND');
    expect(result.exitCode).toBe(2);
  });
});
