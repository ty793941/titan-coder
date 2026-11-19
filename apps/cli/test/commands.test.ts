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

  it('creates a project manager session through the API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: 'session_1', status: 'queued' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCli([
      'session', 'create', 'task_1', '--goal', '执行计划', '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ sessionId: 'session_1' });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/tasks/task_1/sessions'), expect.any(Object));
  });

  it('gets daemon status through the API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ daemonId: 'daemon_1', status: 'ready' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const result = await runCli(['daemon', 'status', 'daemon_1', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ daemonId: 'daemon_1', status: 'ready' });
  });

  it('registers a local daemon through the API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ daemonId: 'daemon_1', status: 'ready' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })));

    const result = await runCli(['daemon', 'register', '--machine', 'dev-machine', '--workspace-root', '/tmp/titan', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ daemonId: 'daemon_1', status: 'ready' });
  });

  it('prints SSE run events as JSON lines', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id: 2\nevent: run.completed\ndata: {"sequence":2}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));

    const result = await runCli(['run', 'events', 'run_1', '--json']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('run.completed');
  });
});
