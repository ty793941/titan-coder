import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contracts from '../src/schemas.js';
import { errorCodes } from '../src/errors.js';

const root = new URL('../../../', import.meta.url);
const sourceRoot = process.env.TITAN_CONTRACT_SOURCE_ROOT
  ? pathToFileURL(`${resolve(process.env.TITAN_CONTRACT_SOURCE_ROOT)}${sep}`)
  : root;
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const load = () => JSON.parse(read('packages/contracts/openapi/control-plane.openapi.json'));
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

function controllerRoutes() {
  const modules = new URL('apps/control-plane/src/modules/', sourceRoot);
  return readdirSync(modules).flatMap(module => {
    const source = readFileSync(new URL(`apps/control-plane/src/modules/${module}/${module}.controller.ts`, sourceRoot), 'utf8');
    const prefix = /@Controller\('([^']+)'\)/.exec(source)?.[1];
    if (!prefix) throw new Error(`Missing controller prefix for ${module}`);
    const matches = [...source.matchAll(/@(Get|Post)\((?:'([^']+)')?\)/g)];
    return matches.map((match, index) => {
      const method = match[1];
      if (!method) throw new Error(`Missing controller method for ${module}`);
      const body = source.slice(match.index! + match[0].length, matches[index + 1]?.index);
      return {
        path: `${prefix}${match[2] ?? ''}`.replace(/:([A-Za-z]+)/g, '{$1}'),
        method: method.toLowerCase(),
        status: /@HttpCode\((\d+)\)/.exec(body)?.[1] ?? (method === 'Post' ? '201' : '200'),
        security: body.includes('this.daemons.authenticate(') ? [{ DaemonBearer: [] }]
          : body.includes('authenticateConsole(') ? [{ ConsoleBearer: [] }] : [],
      };
    });
  });
}

describe('Phase 1 OpenAPI freeze', () => {
  it('publishes valid JSON and exactly the implemented controller routes', () => {
    const api = load();
    expect(api.openapi).toBe('3.1.0');
    const expected = controllerRoutes().map(route => `${route.method} ${route.path}`).sort();
    const actual = Object.entries(api.paths).flatMap(([path, methods]) =>
      Object.keys(methods as object).map(method => `${method} ${path}`)).sort();
    expect(actual).toEqual(expected);
    for (const route of controllerRoutes()) {
      const operation = api.paths[route.path][route.method];
      expect(operation.responses, `${route.method} ${route.path}`).toHaveProperty(route.status);
      expect(operation.security).toEqual(route.security);
      for (const name of [...route.path.matchAll(/\{([^}]+)\}/g)].map(match => match[1])) {
        expect(operation.parameters).toContainEqual({ name, in: 'path', required: true, schema: { type: 'string', minLength: 1 } });
      }
    }
  });

  it('resolves every local reference and gives each operation a unique identifier', () => {
    const api = load();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if ('$ref' in value) {
        const target = String(value.$ref).split('/').slice(1).reduce((node, key) => node?.[key], api);
        expect(target, String(value.$ref)).toBeDefined();
      }
      Object.values(value).forEach(visit);
    };
    visit(api);
    const ids = Object.values(api.paths).flatMap(methods => Object.values(methods as object).map(operation => operation.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['ProjectCreateRequest', contracts.projectCreateRequestSchema.partial({ idempotencyKey: true })],
    ['TaskCreateRequest', contracts.taskCreateRequestSchema],
    ['SessionCreateRequest', contracts.sessionCreateRequestSchema.partial({ idempotencyKey: true })],
    ['RunCreateRequest', contracts.runCreateRequestSchema.partial({ idempotencyKey: true })],
    ['ExecutionConfig', contracts.executionConfigSchema],
    ['CloudSnapshotManifest', contracts.cloudSnapshotManifestSchema],
    ['HandoffCreateRequest', contracts.handoffCreateRequestSchema.partial({ idempotencyKey: true })],
    ['HandoffSnapshotRequest', contracts.handoffSnapshotRequestSchema],
    ['CloudLifecycleRequest', contracts.cloudLifecycleRequestSchema],
    ['ExecutionCheckpoint', contracts.executionCheckpointSchema],
    ['DaemonRegistration', contracts.daemonRegistrationSchema],
    ['DaemonEventRequest', contracts.daemonEventSchema],
    ['Artifact', contracts.artifactSchema],
  ] as const)('keeps %s properties and required fields aligned with Zod', (name, schema) => {
    const declaration = load().components.schemas[name];
    expect(Object.keys(declaration.properties).sort()).toEqual(Object.keys(schema.shape).sort());
    const required = Object.entries(schema.shape).filter(([, field]) => !(field as z.ZodType).isOptional()).map(([key]) => key).sort();
    expect([...(declaration.required ?? [])].sort()).toEqual(required);
    expect(declaration.additionalProperties).toBe(schema._def.unknownKeys !== 'strict');
  });

  it('binds each request to its actual schema and documents header/body idempotency', () => {
    const api = load();
    for (const [path, schema] of [
      ['/api/projects', 'ProjectCreateRequest'],
      ['/api/projects/{projectId}/tasks', 'TaskCreateRequest'],
      ['/api/tasks/{taskId}/sessions', 'SessionCreateRequest'],
      ['/api/sessions/{sessionId}/runs', 'RunCreateRequest'],
      ['/api/runs/{runId}/resume', 'RunCreateRequest'],
      ['/api/tasks/{taskId}/artifacts', 'ArtifactCreateRequest'],
      ['/api/tasks/{taskId}/stage', 'StageRequest'],
      ['/api/daemons/register', 'DaemonRegistration'],
      ['/api/daemons/{daemonId}/heartbeat', 'DaemonHeartbeatRequest'],
      ['/api/daemons/{daemonId}/claim', 'ClaimRequest'],
      ['/api/daemons/{daemonId}/events', 'DaemonEventRequest'],
      ['/api/daemons/{daemonId}/runs/{runId}/progress', 'RunProgress'],
    ] as const) {
      expect(api.paths[path].post.requestBody.content['application/json'].schema).toEqual(ref(schema));
    }
    const header = api.components.parameters.IdempotencyKey;
    expect(header).toMatchObject({ name: 'Idempotency-Key', in: 'header', required: false });
    for (const path of ['/api/projects', '/api/projects/{projectId}/tasks', '/api/tasks/{taskId}/sessions', '/api/sessions/{sessionId}/runs', '/api/runs/{runId}/resume']) {
      expect(api.paths[path].post.parameters).toContainEqual({ $ref: '#/components/parameters/IdempotencyKey' });
      expect(api.paths[path].post['x-idempotency-required']).toBe(true);
      expect(api.components.schemas[api.paths[path].post.requestBody.content['application/json'].schema.$ref.split('/').at(-1)].required).not.toContain('idempotencyKey');
    }
    expect(api.paths['/api/tasks/{taskId}/artifacts'].post['x-idempotency-required']).toBe(false);
  });

  it('documents pause as a 200 Run response without a required request body', () => {
    const pause = load().paths['/api/runs/{runId}/pause']?.post;
    expect(pause).toBeDefined();
    expect(pause.responses['200'].content['application/json'].schema).toEqual(ref('Run'));
    expect(pause).not.toHaveProperty('requestBody');
    expect(pause.security).toEqual([]);
  });

  it('freezes authenticated console state, bounded queries and credential-free execution', () => {
    const api = load();
    const operation = api.paths['/api/console/state']?.get;
    expect(operation).toBeDefined();
    expect(operation.security).toEqual([{ ConsoleBearer: [] }]);
    expect(operation.responses['200'].content['application/json'].schema).toEqual(ref('ConsoleState'));
    expect(operation.parameters).toContainEqual(expect.objectContaining({ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 } }));
    expect(operation.parameters).toContainEqual(expect.objectContaining({ name: 'projectId', in: 'query' }));
    expect(operation.parameters).toContainEqual(expect.objectContaining({ name: 'taskId', in: 'query' }));
    expect(api.components.schemas.ConsoleState.required).toEqual(['projects', 'tasks', 'sessions', 'runs', 'daemons']);
    for (const property of Object.values(api.components.schemas.ConsoleState.properties)) expect(property).toMatchObject({ type: 'array', maxItems: 100 });
    const execution = api.components.schemas.ConsoleExecutionConfig;
    expect(Object.keys(execution.properties).sort()).toEqual(Object.keys(contracts.executionConfigSchema.omit({ credentialRef: true }).shape).sort());
    expect(execution.additionalProperties).toBe(false);
    expect(api.components.schemas.ConsoleDaemonView.additionalProperties).toBe(false);
    expect(api.components.securitySchemes.ConsoleBearer).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('freezes authenticated artifact content and integrity error responses', () => {
    const api = load();
    const operation = api.paths['/api/artifacts/{artifactId}/content']?.get;
    expect(operation).toBeDefined();
    expect(operation.security).toEqual([{ ConsoleBearer: [] }]);
    expect(operation.responses['200'].content['application/json'].schema).toEqual(ref('ArtifactContent'));
    for (const status of ['400', '401', '403', '404', '409']) expect(operation.responses[status]).toBeDefined();
    expect(api.components.schemas.ArtifactContent).toMatchObject({ additionalProperties: false, required: ['content', 'format', 'checksum', 'bytes'] });
    expect(api.components.schemas.ArtifactContent.properties.bytes).toEqual({ type: 'integer', minimum: 0, maximum: 2097152 });
    expect(api.components.schemas.ArtifactContent.properties.format.enum).toEqual(['markdown', 'json', 'text']);
  });

  it('documents resume as a new 201 Run with optional checkpoint and header/body idempotency', () => {
    const api = load();
    const resume = api.paths['/api/runs/{runId}/resume']?.post;
    expect(resume).toBeDefined();
    expect(resume.responses['201'].content['application/json'].schema).toEqual(ref('Run'));
    expect(resume.requestBody).toMatchObject({ required: false, content: { 'application/json': { schema: ref('RunCreateRequest') } } });
    expect(resume.parameters).toContainEqual({ $ref: '#/components/parameters/IdempotencyKey' });
    expect(resume['x-idempotency-required']).toBe(true);
    expect(resume['x-idempotency-scope']).toBe('run:{runId}:resume');
    expect(resume['x-resume-behavior']).toEqual({ createsNewAttempt: true, sourceRunStatus: 'paused', nativeHotResume: false, checkpointFallback: 'latest-on-source-run' });
    const request = api.components.schemas.RunCreateRequest;
    expect(request.required).not.toContain('checkpointId');
    expect(request.required).not.toContain('planHash');
    expect(request.additionalProperties).toBe(false);
  });

  it('accepts paused execution job status for daemon stop polling', () => {
    expect(load().components.schemas.ExecutionJob.properties.status.enum).toContain('paused');
  });

  it('preserves execution limits, checkpoint output presence and conditional progress checkpoint', () => {
    const schemas = load().components.schemas;
    expect(schemas.SessionCreateRequest.required).not.toContain('execution');
    expect(schemas.SessionCreateRequest.properties.execution).toEqual(ref('ExecutionConfig'));
    expect(schemas.ExecutionConfig.properties.runtime.enum).toEqual(['codex', 'qwen']);
    expect(schemas.ExecutionConfig.properties.maxTurns).toMatchObject({ type: 'integer', exclusiveMinimum: 0, maximum: 10000 });
    expect(schemas.ExecutionConfig.properties.timeoutMs.maximum).toBe(86400000);
    expect(schemas.ExecutionCheckpoint.properties.successfulTools.items.required).toContain('output');
    expect(schemas.RunProgress.required).toEqual(['eventId', 'sequence', 'claimToken', 'type', 'payload']);
    expect(schemas.RunProgress.allOf).toContainEqual({ if: { properties: { type: { const: 'checkpoint' } }, required: ['type'] }, then: { required: ['checkpoint'] } });
    expect(schemas.RunDispatch.required).toEqual(['jobId', 'runId', 'sessionId', 'taskId', 'projectId', 'goal', 'planHash', 'config', 'claimToken']);
    expect(schemas.RunDispatch.properties.checkpoint).toEqual(ref('ExecutionCheckpoint'));
  });

  it('preserves the case-insensitive artifact reference accepted by the runtime', () => {
    const output = {
      kind: 'artifact', reference: 'ARTIFACT://ABCDEF12-1234-4ABC-ABCD-ABCDEF123456/result.md',
      uri: 'file:///work/.titan/artifacts/result.md', checksum: `sha256:${'a'.repeat(64)}`, output: 'written',
    };
    expect(contracts.artifactWriteOutputSchema.safeParse(output).success).toBe(true);
    const pattern = load().components.schemas.ArtifactWriteOutput.properties.reference.pattern;
    expect(new RegExp(pattern).test(output.reference)).toBe(true);
  });

  it('matches SSE replay, follow, error frames and empty claim responses', () => {
    const api = load();
    const stream = api.paths['/api/runs/{runId}/events'].get;
    expect(stream.responses['200'].content['text/event-stream'].schema.type).toBe('string');
    expect(stream.parameters).toContainEqual({ $ref: '#/components/parameters/LastEventId' });
    expect(stream.parameters).toContainEqual({ name: 'follow', in: 'query', required: false, schema: { type: 'string' }, description: expect.stringContaining('true') });
    expect(stream['x-sse-data-schema']).toEqual(ref('EventEnvelope'));
    expect(stream['x-sse-error-schema']).toEqual(ref('StreamError'));
    expect(api.paths['/api/daemons/{daemonId}/claim'].post.responses['204']).not.toHaveProperty('content');
    expect(api.paths['/api/daemons/{daemonId}/runs/{runId}/job'].get.responses['200'].content['application/json'].schema).toEqual(ref('ExecutionJob'));
  });

  it('freezes the actual error filter and keeps reserved operations out of REST paths', () => {
    const api = load();
    expect(api.components.schemas.ApiError.required).toEqual(['code', 'message', 'details', 'traceId', 'retryable', 'occurredAt']);
    expect(api.components.schemas.ApiError.properties.code.enum).toEqual([...errorCodes, 'INTERNAL_ERROR']);
    expect(api.components.securitySchemes.DaemonBearer).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(api['x-reserved-only']).toEqual(['ConnectRPC', 'RemoteGitSnapshotTransfer']);
    expect(api.components.schemas.StageRequest).toMatchObject({ additionalProperties: false, required: ['stage', 'expectedVersion'] });
    expect(api.components.schemas.StageRequest.properties.expectedVersion).toMatchObject({ type: 'integer', exclusiveMinimum: 0, maximum: 2147483646 });
  });

  it('freezes bounded cloud dispatch and keeps lifecycle separate from seven run progress types', () => {
    const api = load();
    const schemas = api.components.schemas;
    expect(schemas.RunDispatch.properties.cloud).toEqual(ref('CloudDispatch'));
    expect(schemas.CloudDispatch.required).toEqual(['executionId', 'snapshot', 'secretLeaseId', 'secretLeaseExpiresAt']);
    expect(schemas.CloudSnapshotManifest.additionalProperties).toBe(false);
    expect(schemas.RunProgress.properties.type.enum).toEqual(['running', 'output', 'checkpoint', 'completed', 'failed', 'cancelled', 'waiting_input']);
    expect(api.paths['/api/sessions/{id}/handoff'].post.security).toEqual([{ ConsoleBearer: [] }]);
    expect(api.paths['/api/daemons/{id}/handoffs/{handoffId}/snapshot'].post.security).toEqual([{ DaemonBearer: [] }]);
    expect(api.paths['/api/daemons/{id}/runs/{runId}/cloud'].post.requestBody.content['application/json'].schema).toEqual(ref('CloudLifecycleRequest'));
  });
});
