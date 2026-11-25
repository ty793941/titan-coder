import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlPlaneClient, WorkflowClientError, resolveWorkflowBearer } from '../src/control-plane-client.js';

const servers: Server[] = [];

async function listen(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('ControlPlaneClient', () => {
  it.each(['http://example.com', 'http://127.0.0.1:3301?token=secret', 'http://user:pass@127.0.0.1:3301', 'file:///tmp/cp'])('rejects unsafe control-plane URL %s', (baseUrl) => {
    expect(() => new ControlPlaneClient({ baseUrl, bearer: 'workflow-secret' })).toThrowError(/VALIDATION_FAILED/);
  });

  it('sends the Workflow bearer in a header and strictly projects observations', async () => {
    const baseUrl = await listen((request, response) => {
      expect(request.headers.authorization).toBe('Bearer workflow-secret-1');
      expect(request.url).toBe('/api/internal/workflow/jobs/job_1');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jobId: 'job_1', status: 'running', deadlineAt: '2099-01-01T00:00:00.000Z' }));
    });
    const client = new ControlPlaneClient({ baseUrl, bearer: 'workflow-secret-1' });
    await expect(client.observeJob({ jobId: 'job_1', workflowVersion: 1 })).resolves.toEqual({
      jobId: 'job_1', status: 'running', deadlineAt: '2099-01-01T00:00:00.000Z',
    });
  });

  it('reads the safe workflow execution target used to cancel scheduled occurrences', async () => {
    const baseUrl = await listen((request, response) => {
      expect(request.url).toBe('/api/internal/workflow/jobs/job_1/execution');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jobId: 'job_1', workflowId: 'schedule_1/v3', workflowVersion: 1 }));
    });
    const client = new ControlPlaneClient({ baseUrl, bearer: 'workflow-secret-1' });
    await expect(client.getJobExecution('job_1')).resolves.toEqual({
      jobId: 'job_1', workflowId: 'schedule_1/v3', workflowVersion: 1,
    });
  });

  it('accepts the colon and slash characters used by Temporal occurrence IDs', async () => {
    const occurrenceId = 'schedule_1/occurrence:2030-02-03T04.05.06.000Z';
    const baseUrl = await listen((request, response) => {
      expect(request.url).toBe('/api/internal/workflow/schedules/schedule_1/occurrences');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'skipped' }));
      void request;
    });
    const client = new ControlPlaneClient({ baseUrl, bearer: 'workflow-secret-1' });
    await expect(client.scheduleOccurrence({
      scheduleId: 'schedule_1', definitionVersion: 3, occurrenceId, scheduledAt: '2030-02-03T04:05:06.000Z',
    })).resolves.toEqual({ status: 'skipped' });
  });

  it('does not expose strict projection failures or response bodies', async () => {
    const baseUrl = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jobId: 'job_1', status: 'running', deadlineAt: '2099-01-01T00:00:00.000Z', credential: 'model-secret' }));
    });
    const client = new ControlPlaneClient({ baseUrl, bearer: 'workflow-secret-1' });
    await expect(client.observeJob({ jobId: 'job_1', workflowVersion: 1 })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(WorkflowClientError);
      expect((error as WorkflowClientError).code).toBe('WORKFLOW_COMMAND_FAILED');
      expect((error as Error).message).not.toContain('model-secret');
      expect((error as Error).message).not.toContain(baseUrl);
      return true;
    });
  });

  it('rejects redirects without following the target', async () => {
    const baseUrl = await listen((_request, response) => {
      response.statusCode = 302;
      response.setHeader('location', 'http://example.com/leak');
      response.end('redirect-body-secret');
    });
    const client = new ControlPlaneClient({ baseUrl, bearer: 'workflow-secret-1' });
    await expect(client.observeJob({ jobId: 'job_1', workflowVersion: 1 })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(WorkflowClientError);
      expect((error as WorkflowClientError).code).toBe('DAEMON_UNAVAILABLE');
      expect((error as Error).message).not.toContain('redirect-body-secret');
      expect((error as Error).message).not.toContain('example.com');
      return true;
    });
  });

  it('bounds JSON response size at two MiB', async () => {
    const baseUrl = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jobId: 'job_1', status: 'running', deadlineAt: '2099-01-01T00:00:00.000Z', extra: 'x'.repeat(2 * 1024 * 1024) }));
    });
    const client = new ControlPlaneClient({ baseUrl, bearer: 'workflow-secret-1' });
    await expect(client.observeJob({ jobId: 'job_1', workflowVersion: 1 })).rejects.toMatchObject({ code: 'WORKFLOW_COMMAND_FAILED' });
  });

  it('loads a Workflow bearer once from an injected secure source', async () => {
    let reads = 0;
    await expect(resolveWorkflowBearer('keychain://titan-workflow', {
      readKeychain: async () => { reads += 1; return 'workflow-secret-1'; },
    })).resolves.toBe('workflow-secret-1');
    expect(reads).toBe(1);
  });
});
