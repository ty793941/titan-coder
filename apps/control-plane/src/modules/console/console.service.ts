import { Inject, Injectable } from '@nestjs/common';
import { DomainError, executionConfigSchema } from '@titan/contracts';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import type { JsonValue } from '../../database/types.js';
import { daemonStatus } from '../daemons/execution-policy.js';

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const querySchema = z.object({
  projectId: identifier.optional(), taskId: identifier.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict();
const publicExecutionSchema = executionConfigSchema.omit({ credentialRef: true });

function publicExecution(value: JsonValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return publicExecutionSchema.parse({
    daemonId: value.daemonId, runtime: value.runtime, modelRef: value.modelRef, workspacePath: value.workspacePath,
    allowedTools: value.allowedTools, maxTurns: value.maxTurns, timeoutMs: value.timeoutMs,
  });
}

@Injectable()
export class ConsoleService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async state(input: unknown) {
    const query = querySchema.parse(input);
    return this.database.db.transaction().setIsolationLevel('repeatable read').execute(async db => {
      let projectId = query.projectId;
      if (query.taskId) {
        const task = await db.selectFrom('task').select(['id', 'project_id']).where('id', '=', query.taskId).executeTakeFirst();
        if (!task || (projectId && task.project_id !== projectId)) throw new DomainError('RESOURCE_NOT_FOUND', 'selected task was not found in the project');
        projectId = task.project_id;
      }
      let projectsQuery = db.selectFrom('project').select(['id', 'name', 'goal', 'version', 'created_at']);
      if (projectId) projectsQuery = projectsQuery.where('id', '=', projectId);
      const projects = await projectsQuery.orderBy('created_at', 'desc').orderBy('id', 'asc').limit(query.limit).execute();
      if (projectId && projects.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 'selected project was not found');
      let tasksQuery = db.selectFrom('task').selectAll().where('project_id', 'in', projects.map(row => row.id));
      if (query.taskId) tasksQuery = tasksQuery.where('id', '=', query.taskId);
      const tasks = projects.length ? await tasksQuery.orderBy('created_at', 'desc').orderBy('id', 'asc').limit(query.limit).execute() : [];
      const sessions = tasks.length ? await db.selectFrom('session')
        .select(['id', 'task_id', 'status', 'plan_hash', 'execution_config', 'created_at'])
        .where('task_id', 'in', tasks.map(row => row.id)).orderBy('created_at', 'desc').orderBy('id', 'asc').limit(query.limit).execute() : [];
      const runs = sessions.length ? await db.selectFrom('run')
        .select(['id', 'session_id', 'attempt', 'status', 'checkpoint_id', 'error_code', 'created_at'])
        .where('session_id', 'in', sessions.map(row => row.id)).orderBy('created_at', 'desc').orderBy('id', 'asc').limit(query.limit).execute() : [];
      const daemons = await db.selectFrom('daemon')
        .select(['id', 'machine_name', 'environment_type', 'capabilities', 'workspace_roots', 'max_concurrent_sessions', 'daemon_version', 'status', 'last_heartbeat_at'])
        .where('environment_type', '=', 'local').orderBy('created_at', 'desc').orderBy('id', 'asc').limit(query.limit).execute();
      return {
        projects: projects.map(row => ({ id: row.id, name: row.name, goal: row.goal, version: row.version, createdAt: row.created_at.toISOString() })),
        tasks: tasks.map(row => ({ id: row.id, projectId: row.project_id, title: row.title, goal: row.goal,
          acceptanceCriteria: row.acceptance_criteria as string[], priority: row.priority, stage: row.stage, status: row.status,
          version: row.version, createdAt: row.created_at.toISOString() })),
        sessions: sessions.map(row => ({ id: row.id, taskId: row.task_id, status: row.status,
          ...(row.plan_hash ? { planHash: row.plan_hash } : {}),
          ...(row.execution_config ? { execution: publicExecution(row.execution_config) } : {}), createdAt: row.created_at.toISOString() })),
        runs: runs.map(row => ({ id: row.id, sessionId: row.session_id, attempt: row.attempt, status: row.status,
          ...(row.checkpoint_id ? { checkpointId: row.checkpoint_id } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}), createdAt: row.created_at.toISOString() })),
        daemons: daemons.map(row => ({ daemonId: row.id, machineName: row.machine_name, environmentType: row.environment_type,
          capabilities: row.capabilities as string[], workspaceRoots: row.workspace_roots as string[], maxConcurrentSessions: row.max_concurrent_sessions,
          daemonVersion: row.daemon_version, status: daemonStatus(row), lastHeartbeatAt: row.last_heartbeat_at.toISOString() })),
      };
    });
  }
}
