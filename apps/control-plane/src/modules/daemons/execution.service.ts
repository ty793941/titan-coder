import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { artifactWriteOutputSchema, DomainError, executionCheckpointSchema, executionConfigSchema, progressOutputSchema, runProgressSchema } from '@titan/contracts';
import type { ExecutionCheckpoint, ExecutionConfig, ProgressAck, RunDispatch } from '@titan/daemon-protocol';
import { sql, type Transaction } from 'kysely';
import type { Database, JsonValue } from '../../database/types.js';
import { DatabaseService } from '../../database/database.service.js';
import { EventsService } from '../events/events.service.js';
import { canonicalJson, daemonStatus, latestApprovedPlan, sameToken, tokenHash, validateExecution } from './execution-policy.js';
import { CloudExecutionsService } from '../cloud-executions/cloud-executions.service.js';
import { cloudArtifactScope } from '../artifacts/cloud-artifact-scope.js';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const leaseMs = 120000;
const maxCheckpointBytes = 1024 * 1024;

const sensitiveKey = /(?:api.?key|secret|password|authorization|token|credential|private.?key)/i;

function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new DomainError('VALIDATION_FAILED', 'progress payload is too deeply nested');
  if (typeof value === 'string') {
    return value.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|(?:api[_-]?key|access[_-]?token|password|secret|claimToken)\s*[=:]\s*[^\s,"'}]+)/gi, '[REDACTED]');
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : redactSecrets(item, depth + 1)]));
  }
  return null;
}

function normalizeCheckpoint(value: unknown): ExecutionCheckpoint {
  const checkpoint = executionCheckpointSchema.parse(value) as ExecutionCheckpoint;
  const safe = redactSecrets(checkpoint) as ExecutionCheckpoint;
  if (Buffer.byteLength(JSON.stringify(safe), 'utf8') > maxCheckpointBytes) {
    throw new DomainError('VALIDATION_FAILED', 'checkpoint exceeds the 1 MiB persistence limit');
  }
  return safe;
}

function parseArtifactOutput(value: unknown, workspacePath: string): ReturnType<typeof artifactWriteOutputSchema.parse> | undefined {
  if (!value || typeof value !== 'object' || (value as { kind?: unknown }).kind !== 'artifact') return undefined;
  if (!('uri' in value) || !('checksum' in value)) return undefined;
  const output = artifactWriteOutputSchema.parse(value);
  const match = /^artifact:\/\/([0-9a-f-]{36})\/(.+)$/i.exec(output.reference);
  if (!match) throw new DomainError('VALIDATION_FAILED', 'artifact reference is invalid');
  let logicalPath: string;
  try {
    logicalPath = decodeURIComponent(match[2]!);
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'artifact reference contains invalid escaping');
  }
  const segments = logicalPath.split('/');
  if (!logicalPath || logicalPath.startsWith('/') || logicalPath.includes('\\') || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new DomainError('PERMISSION_DENIED', 'artifact reference escapes its logical artifact directory');
  }
  let artifactPath: string;
  try {
    const uri = new URL(output.uri);
    if (uri.protocol !== 'file:' || uri.hostname || uri.search || uri.hash) throw new Error('artifact URI must be a local file URI');
    artifactPath = fileURLToPath(uri);
  } catch {
    throw new DomainError('PERMISSION_DENIED', 'artifact URI must be a local file URI');
  }
  const artifactRoot = resolve(workspacePath, '.titan', 'artifacts');
  const pathRelativeToRoot = relative(artifactRoot, resolve(artifactPath));
  const expectedRelativePath = `${match[1]}/${logicalPath}`.replaceAll('/', process.platform === 'win32' ? '\\' : '/');
  if (!pathRelativeToRoot || pathRelativeToRoot === '..' || pathRelativeToRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || resolve(pathRelativeToRoot) !== resolve(expectedRelativePath)) {
    throw new DomainError('PERMISSION_DENIED', 'artifact URI is outside the configured artifact directory');
  }
  return output;
}

@Injectable()
export class ExecutionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(CloudExecutionsService) private readonly cloud: CloudExecutionsService,
  ) {}

  async claim(daemonId: string): Promise<RunDispatch | undefined> {
    return this.database.db.transaction().execute(async trx => {
      const daemon = await trx.selectFrom('daemon').selectAll().where('id', '=', daemonId).forUpdate().executeTakeFirst();
      if (!daemon || daemonStatus(daemon) !== 'ready') throw new DomainError('DAEMON_UNAVAILABLE', 'daemon must be ready before claiming work');
      await this.expireLostClaims(trx, daemonId, new Date());
      const active = await trx.selectFrom('execution_job').select(({ fn }) => fn.countAll().as('count'))
        .where('daemon_id', '=', daemonId).where('status', '=', 'claimed').executeTakeFirstOrThrow();
      if (Number(active.count) >= daemon.max_concurrent_sessions) return undefined;
      for (let scanned = 0; scanned < 100; scanned++) {
        const job = await trx.selectFrom('execution_job').selectAll().where('daemon_id', '=', daemonId)
          .where('status', '=', 'queued').where('cancel_requested', '=', false).orderBy('created_at', 'asc').orderBy('id', 'asc')
          .forUpdate().skipLocked().executeTakeFirst();
        if (!job) return undefined;
        const context = await trx.selectFrom('run').innerJoin('session', 'session.id', 'run.session_id')
          .innerJoin('task', 'task.id', 'session.task_id')
          .select(['run.status', 'run.checkpoint_id', 'session.id as session_id', 'task.id as task_id', 'task.project_id'])
          .where('run.id', '=', job.run_id).executeTakeFirstOrThrow();
        if (terminal.has(context.status)) {
          await trx.updateTable('execution_job').set({ status: context.status, claim_token_hash: null, lease_expires_at: null }).where('id', '=', job.id).execute();
          continue;
        }
        try {
          await latestApprovedPlan(trx, context.task_id, job.plan_hash);
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'PLAN_HASH_STALE') throw error;
          await trx.updateTable('execution_job').set({ status: 'blocked' }).where('id', '=', job.id).execute();
          await trx.updateTable('run').set(eb => ({ status: 'waiting_input', error_code: 'PLAN_HASH_STALE', version: eb('version', '+', 1) })).where('id', '=', job.run_id).execute();
          await trx.updateTable('session').set(eb => ({ status: 'waiting_input', version: eb('version', '+', 1) })).where('id', '=', context.session_id).execute();
          await this.cloud.finish(trx, job.run_id, 'failed', 'PLAN_HASH_STALE');
          await this.events.append(trx, { eventType: 'run.waiting_input', projectId: context.project_id, taskId: context.task_id,
            sessionId: context.session_id, runId: job.run_id, actor: { type: 'system', id: 'control-plane' }, payload: { errorCode: 'PLAN_HASH_STALE' } });
          continue;
        }
        const config = executionConfigSchema.parse(job.config) as ExecutionConfig;
        await validateExecution(trx, config);
        let checkpoint: ExecutionCheckpoint | undefined;
        if (context.checkpoint_id) {
          const saved = await trx.selectFrom('checkpoint').innerJoin('run', 'run.id', 'checkpoint.run_id')
            .select(['checkpoint.snapshot', 'run.session_id']).where('checkpoint.id', '=', context.checkpoint_id).executeTakeFirst();
          if (!saved || saved.session_id !== context.session_id) throw new DomainError('VALIDATION_FAILED', 'checkpoint is not owned by the session');
          checkpoint = normalizeCheckpoint(saved.snapshot);
        }
        const claimToken = randomBytes(32).toString('hex');
        const leaseExpiresAt = new Date(Date.now() + leaseMs);
        let cloud: RunDispatch['cloud'];
        if (config.environmentType === 'cloud') {
          try { cloud = await this.cloud.dispatch(trx, job.run_id, leaseExpiresAt); }
          catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'CLOUD_SECRET_LEASE_EXPIRED') throw error;
            await trx.updateTable('execution_job').set({ status: 'blocked' }).where('id', '=', job.id).execute();
            await trx.updateTable('run').set(eb => ({ status: 'waiting_input', error_code: error.code, version: eb('version', '+', 1) })).where('id', '=', job.run_id).execute();
            await trx.updateTable('session').set(eb => ({ status: 'waiting_input', version: eb('version', '+', 1) })).where('id', '=', context.session_id).execute();
            await this.cloud.finish(trx, job.run_id, 'failed', error.code);
            await this.events.append(trx, { eventType: 'run.waiting_input', projectId: context.project_id, taskId: context.task_id, sessionId: context.session_id, runId: job.run_id, actor: { type: 'system', id: 'control-plane' }, payload: { errorCode: error.code } });
            continue;
          }
        }
        await trx.updateTable('execution_job').set({ status: 'claimed', claim_token_hash: tokenHash(claimToken), lease_expires_at: leaseExpiresAt }).where('id', '=', job.id).execute();
        return {
          jobId: job.id, runId: job.run_id, sessionId: context.session_id, taskId: context.task_id,
          projectId: context.project_id, goal: job.goal, planHash: job.plan_hash, config, claimToken,
          ...(checkpoint ? { checkpoint } : {}),
          ...(cloud ? { cloud } : {}),
        };
      }
      return undefined;
    });
  }

  async progress(daemonId: string, runId: string, source: unknown): Promise<ProgressAck> {
    const input = runProgressSchema.parse(source);
    const checkpoint = input.checkpoint ? normalizeCheckpoint(input.checkpoint) : undefined;
    const { claimToken, ...content } = input;
    const requestHash = tokenHash(canonicalJson({ ...content, ...(checkpoint ? { checkpoint } : {}) }));
    const result = await this.database.db.transaction().execute<ProgressAck | DomainError>(async trx => {
      const daemon = await trx.selectFrom('daemon').selectAll().where('id', '=', daemonId).forUpdate().executeTakeFirstOrThrow();
      if (daemon.status === 'revoked') throw new DomainError('PERMISSION_DENIED', 'daemon is revoked');
      const job = await trx.selectFrom('execution_job').selectAll().where('run_id', '=', runId).where('daemon_id', '=', daemonId).forUpdate().executeTakeFirst();
      if (!job) throw new DomainError('RESOURCE_NOT_FOUND', 'execution job was not found');
      const run = await trx.selectFrom('run').selectAll().where('id', '=', runId).forUpdate().executeTakeFirstOrThrow();
      const isCloud = executionConfigSchema.parse(job.config).environmentType === 'cloud';
      const fenced = (jobStatus: 'blocked' | 'cancelled' = 'blocked') => new DomainError('PERMISSION_DENIED', 'cloud progress is fenced', {
        reason: 'CLOUD_PROGRESS_FENCED', environmentType: 'cloud', daemonId, runId, eventId: input.eventId,
        jobStatus, runStatus: jobStatus === 'cancelled' ? 'cancelled' : 'reconnecting',
      });
      if (isCloud && job.status === 'blocked' && job.cancel_requested && job.claim_token_hash === null && job.lease_expires_at === null &&
        run.status === 'reconnecting' && run.error_code === 'CLOUD_WORKER_DISCONNECTED') return fenced();
      if (isCloud && job.status === 'cancelled' && job.cancel_requested && job.claim_token_hash === null && job.lease_expires_at === null && run.status === 'cancelled') {
        // 管理取消可覆盖运行状态；只能凭同一执行的持久隔离事实继续拒绝旧进度。
        const proof = await trx.selectFrom('cloud_execution').select('id').where('run_id', '=', runId).where('daemon_id', '=', daemonId)
          .where('session_id', '=', run.session_id).where('status', '=', 'cancelled').where('error_code', '=', 'CLOUD_WORKER_DISCONNECTED')
          .where('lease_expires_at', 'is', null).executeTakeFirst();
        if (proof) return fenced('cancelled');
      }
      if (!sameToken(claimToken, job.claim_token_hash)) throw new DomainError('PERMISSION_DENIED', 'invalid claim token');
      if (isCloud && daemonStatus(daemon) !== 'ready') {
        await this.cloud.disconnect(trx, runId);
        // 先提交隔离事实，再在事务外返回拒绝，避免异常回滚使旧领取证明继续有效。
        if (job.status === 'claimed' && !terminal.has(run.status)) return fenced();
        return new DomainError('PERMISSION_DENIED', 'cloud daemon heartbeat is not ready');
      }
      const context = await trx.selectFrom('session').innerJoin('task', 'task.id', 'session.task_id')
        .select(['task.project_id', 'task.id as task_id']).where('session.id', '=', run.session_id).executeTakeFirstOrThrow();
      const ack = (accepted: boolean): ProgressAck => ({ accepted, status: run.status, cancelRequested: job.cancel_requested || run.status === 'paused' });
      await sql`select pg_advisory_xact_lock(hashtextextended(${`progress:${input.eventId}`}, 0))`.execute(trx);
      const previous = await trx.selectFrom('execution_progress').selectAll().where('event_id', '=', input.eventId).executeTakeFirst();
      if (previous) {
        if (previous.job_id !== job.id || previous.request_hash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', 'eventId was reused with different progress');
        return ack(false);
      }
      if (run.status === 'paused') return { accepted: false, status: 'paused', cancelRequested: true };
      if (terminal.has(run.status)) return ack(false);
      if (isCloud && job.status === 'claimed') {
        const execution = await trx.selectFrom('cloud_execution').select('lease_expires_at').where('run_id', '=', runId).executeTakeFirstOrThrow();
        if (!job.lease_expires_at || job.lease_expires_at.getTime() <= Date.now() || !execution.lease_expires_at || execution.lease_expires_at.getTime() <= Date.now()) {
          await this.cloud.disconnect(trx, runId);
          return fenced();
        }
      }
      if (!job.lease_expires_at || job.lease_expires_at.getTime() <= Date.now() || job.status !== 'claimed') throw new DomainError('PERMISSION_DENIED', 'claim lease expired');
      if (input.sequence !== Number(job.last_sequence) + 1) throw new DomainError('EVENT_SEQUENCE_GAP', 'progress sequence must be contiguous');
      await trx.insertInto('execution_progress').values({ event_id: input.eventId, job_id: job.id, sequence: input.sequence, request_hash: requestHash }).execute();
      if (checkpoint) {
        const saved = await trx.selectFrom('checkpoint').selectAll().where('id', '=', checkpoint.id).executeTakeFirst();
        if (saved) {
          if (saved.run_id !== runId || canonicalJson(saved.snapshot) !== canonicalJson(checkpoint)) throw new DomainError('VERSION_CONFLICT', 'checkpoint id already belongs to another snapshot');
        } else {
          await trx.insertInto('checkpoint').values({ id: checkpoint.id, run_id: runId, sequence: input.sequence, snapshot: JSON.stringify(checkpoint) }).execute();
        }
      }
      const output = this.progressOutput(input.payload);
      await this.registerProgressArtifacts(trx, job, run, context, checkpoint, output?.output ?? input.payload.output);
      const status = ['output', 'checkpoint'].includes(input.type) ? run.status : input.type;
      await trx.updateTable('run').set({ status, version: run.version + 1,
        ...(checkpoint ? { checkpoint_id: checkpoint.id } : {}),
        ...(input.type === 'failed' ? { error_code: this.progressErrorCode(input.payload) } : {}),
      }).where('id', '=', runId).execute();
      await trx.updateTable('session').set(eb => ({ status, version: eb('version', '+', 1) })).where('id', '=', run.session_id).execute();
      await trx.updateTable('execution_job').set({ status: terminal.has(status) || status === 'waiting_input' ? status : 'claimed', last_sequence: input.sequence,
        lease_expires_at: new Date(Date.now() + leaseMs), ...(status === 'cancelled' ? { cancel_requested: true } : {}),
      }).where('id', '=', job.id).execute();
      await this.cloud.renew(trx, runId, new Date(Date.now() + leaseMs));
      await this.cloud.finish(trx, runId, status, input.type === 'failed' ? this.progressErrorCode(input.payload) : undefined);
      if (status === 'waiting_input') await this.cloud.finish(trx, runId, 'failed', 'CLOUD_RUNTIME_WAITING_INPUT');
      if (output) await this.recordProgressAudit(trx, runId, daemonId, input.eventId, output);
      const safePayload = redactSecrets(input.payload) as Record<string, unknown>;
      await this.events.append(trx, { eventId: input.eventId, eventType: `run.${input.type}`, projectId: context.project_id, taskId: context.task_id,
        sessionId: run.session_id, runId, actor: { type: 'daemon', id: daemonId },
        payload: { ...safePayload, progressEventId: input.eventId, progressSequence: input.sequence, ...(checkpoint ? { checkpointId: checkpoint.id } : {}) },
      });
      return { accepted: true, status, cancelRequested: job.cancel_requested || status === 'cancelled' };
    });
    if (result instanceof DomainError) throw result;
    return result;
  }

  private progressErrorCode(payload: Record<string, unknown>): string {
    if (typeof payload.errorCode === 'string' && payload.errorCode.length > 0) return payload.errorCode;
    if (typeof payload.code === 'string' && payload.code.length > 0) return payload.code;
    return 'TOOL_EXECUTION_FAILED';
  }

  private progressOutput(payload: Record<string, unknown>): ReturnType<typeof progressOutputSchema.parse> | undefined {
    if (!Object.prototype.hasOwnProperty.call(payload, 'source')) return undefined;
    return progressOutputSchema.parse(payload);
  }

  private async expireLostClaims(trx: Transaction<Database>, daemonId: string, now: Date): Promise<void> {
    const jobs = await trx.selectFrom('execution_job').selectAll()
      .where('daemon_id', '=', daemonId).where('status', '=', 'claimed').where('lease_expires_at', '<=', now)
      .forUpdate().execute();
    for (const job of jobs) {
      const run = await trx.selectFrom('run').selectAll().where('id', '=', job.run_id).forUpdate().executeTakeFirstOrThrow();
      if (terminal.has(run.status)) {
        await trx.updateTable('execution_job').set({ status: run.status, claim_token_hash: null, lease_expires_at: null }).where('id', '=', job.id).execute();
        continue;
      }
      const context = await trx.selectFrom('session').innerJoin('task', 'task.id', 'session.task_id')
        .select(['session.id as session_id', 'task.id as task_id', 'task.project_id']).where('session.id', '=', run.session_id).executeTakeFirstOrThrow();
      const isCloud = executionConfigSchema.parse(job.config).environmentType === 'cloud';
      if (isCloud) { await this.cloud.disconnect(trx, run.id); continue; }
      const status = run.checkpoint_id ? 'paused' : 'waiting_input';
      await trx.updateTable('execution_job').set({ status: 'blocked', cancel_requested: true, claim_token_hash: null, lease_expires_at: null }).where('id', '=', job.id).execute();
      await trx.updateTable('run').set({ status, error_code: 'EXECUTION_LEASE_EXPIRED', version: run.version + 1 }).where('id', '=', run.id).execute();
      await trx.updateTable('session').set(eb => ({ status, version: eb('version', '+', 1) })).where('id', '=', run.session_id).execute();
      await this.events.append(trx, {
        eventType: status === 'paused' ? 'run.paused' : 'run.waiting_input', projectId: context.project_id, taskId: context.task_id,
        sessionId: context.session_id, runId: run.id, actor: { type: 'system', id: 'control-plane' },
        payload: { errorCode: 'EXECUTION_LEASE_EXPIRED', reason: 'daemon claim lease expired before completion', retryRequiresHuman: true },
      });
    }
  }

  private async registerProgressArtifacts(
    trx: Transaction<Database>,
    job: Pick<Database['execution_job'], 'plan_hash' | 'config' | 'daemon_id'>,
    run: Database['run'],
    context: { project_id: string; task_id: string },
    checkpoint: ExecutionCheckpoint | undefined,
    toolOutput?: unknown,
  ): Promise<void> {
    const config = executionConfigSchema.parse(job.config);
    const values = [...(checkpoint?.successfulTools.map(tool => tool.output) ?? []), ...(config.environmentType === 'cloud' && toolOutput ? [toolOutput] : [])];
    if (!values.some(value => value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'artifact')) return;
    const workspacePath = config.environmentType === 'cloud' ? (await cloudArtifactScope(trx, run.session_id, job.daemon_id)).workspacePath : config.workspacePath;
    const outputs = values
      .map(value => {
        if (config.environmentType === 'cloud' && value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'artifact') artifactWriteOutputSchema.parse(value);
        return parseArtifactOutput(value, workspacePath);
      })
      .filter((output): output is ReturnType<typeof artifactWriteOutputSchema.parse> => output !== undefined);
    if (outputs.length === 0) return;
    const plan = await trx.selectFrom('artifact').select(['artifact_id'])
      .where('task_id', '=', context.task_id).where('type', '=', 'plan').where('checksum', '=', job.plan_hash)
      .where('status', '=', 'approved').where('review_state', '=', 'approved').executeTakeFirst();
    for (const output of outputs) {
      const metadata = redactSecrets(output) as Record<string, unknown>;
      const existing = await trx.selectFrom('artifact').selectAll().where('reference', '=', output.reference).executeTakeFirst()
        ?? await trx.selectFrom('artifact').selectAll().where('uri', '=', output.uri).executeTakeFirst();
      if (existing) {
        if (existing.checksum !== output.checksum || existing.type !== output.artifactType || canonicalJson(existing.metadata) !== canonicalJson(metadata)) {
          throw new DomainError('VERSION_CONFLICT', 'artifact metadata is immutable and cannot be replaced');
        }
        continue;
      }
      const previous = await trx.selectFrom('artifact').select(({ fn }) => fn.max('version').as('max_version'))
        .where('task_id', '=', context.task_id).where('type', '=', output.artifactType).executeTakeFirst();
      const version = Number(previous?.max_version ?? 0) + 1;
      const artifactId = `artifact_${randomUUID()}`;
      await trx.insertInto('artifact').values({
        artifact_id: artifactId, project_id: context.project_id, task_id: context.task_id, session_id: run.session_id,
        type: output.artifactType, version, schema_version: 1, uri: output.uri, checksum: output.checksum,
        status: 'draft', source_artifacts: JSON.stringify(plan ? [plan.artifact_id] : []),
        created_by_type: 'daemon', created_by_id: job.daemon_id, created_at: new Date(), review_state: 'pending',
        reference: output.reference, metadata: metadata as JsonValue,
      }).execute();
      await this.events.append(trx, {
        eventType: 'artifact.created', projectId: context.project_id, taskId: context.task_id, sessionId: run.session_id, runId: run.id,
        actor: { type: 'daemon', id: job.daemon_id }, payload: { artifactId, reference: output.reference, uri: output.uri, checksum: output.checksum, artifactType: output.artifactType, version },
      });
    }
  }

  private async recordProgressAudit(
    trx: Transaction<Database>,
    runId: string,
    daemonId: string,
    eventId: string,
    output: ReturnType<typeof progressOutputSchema.parse>,
  ): Promise<void> {
    const safeOutput = redactSecrets(output.output) as JsonValue;
    const payload = { source: output.source, status: output.status, toolName: output.toolName, toolCallId: output.toolCallId, output: safeOutput } as JsonValue;
    if (output.source === 'tool') {
      const existing = await trx.selectFrom('tool_call').selectAll().where('run_id', '=', runId).where('tool_use_id', '=', output.toolCallId).executeTakeFirst();
      if (!existing) {
        await trx.insertInto('tool_call').values({ id: `tool_call_${randomUUID()}`, run_id: runId, tool_use_id: output.toolCallId, tool_name: output.toolName, status: output.status, result: safeOutput, created_at: new Date() }).execute();
      } else {
        await trx.updateTable('tool_call').set({ status: output.status, ...(output.output !== undefined ? { result: safeOutput } : {}) }).where('id', '=', existing.id).execute();
      }
    } else {
      await trx.insertInto('hook_execution').values({ id: `hook_${randomUUID()}`, run_id: runId, hook_name: output.hookName ?? output.toolName, status: output.status, duration_ms: 0, created_at: new Date() }).execute();
    }
    await trx.insertInto('audit_log').values({
      id: `audit_${randomUUID()}`, actor_type: 'daemon', actor_id: daemonId, action: 'execution.progress.output',
      target_type: output.source === 'tool' ? 'tool_call' : 'hook_execution', target_id: output.toolCallId, trace_id: eventId, payload, created_at: new Date(),
    }).execute();
  }

  async control(daemonId: string, runId: string): Promise<{ cancelRequested: boolean; status: string }> {
    return this.database.db.transaction().execute(async trx => {
      const daemon = await trx.selectFrom('daemon').selectAll().where('id', '=', daemonId).forUpdate().executeTakeFirst();
      if (!daemon || daemon.status === 'revoked') throw new DomainError('PERMISSION_DENIED', 'daemon is unavailable');
      const row = await trx.selectFrom('execution_job').innerJoin('run', 'run.id', 'execution_job.run_id')
        .select(['execution_job.id', 'execution_job.cancel_requested', 'execution_job.status as job_status', 'execution_job.lease_expires_at', 'run.status'])
        .where('execution_job.daemon_id', '=', daemonId).where('run.id', '=', runId).forUpdate().executeTakeFirst();
      if (!row) throw new DomainError('RESOURCE_NOT_FOUND', 'execution job was not found');
      const now = new Date();
      const execution = await trx.selectFrom('cloud_execution').select('lease_expires_at').where('run_id', '=', runId).executeTakeFirst();
      if (execution && row.job_status === 'claimed' && (daemonStatus(daemon) !== 'ready' || !row.lease_expires_at || row.lease_expires_at.getTime() <= now.getTime() || !execution.lease_expires_at || execution.lease_expires_at.getTime() <= now.getTime())) {
        await this.cloud.disconnect(trx, runId);
        return { cancelRequested: true, status: 'reconnecting' };
      }
      if (daemonStatus(daemon) === 'ready' && row.job_status === 'claimed' && row.lease_expires_at && row.lease_expires_at.getTime() > now.getTime()) {
        await trx.updateTable('execution_job').set({ lease_expires_at: new Date(now.getTime() + leaseMs) }).where('id', '=', row.id).execute();
        await this.cloud.renew(trx, runId, new Date(now.getTime() + leaseMs));
      }
      return { cancelRequested: row.cancel_requested || row.status === 'paused', status: row.status };
    });
  }

  async job(daemonId: string, runId: string) {
    const row = await this.database.db.selectFrom('execution_job').select(['id', 'run_id', 'status', 'cancel_requested', 'last_sequence', 'lease_expires_at'])
      .where('daemon_id', '=', daemonId).where('run_id', '=', runId).executeTakeFirst();
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND', 'execution job was not found');
    return { jobId: row.id, runId: row.run_id, status: row.status, cancelRequested: row.cancel_requested || row.status === 'paused', lastSequence: Number(row.last_sequence), leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null };
  }
}
