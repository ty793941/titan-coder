import type { EventId, ProjectId, RunId, SessionId, TaskId } from './ids.js';

export type ActorType = 'user' | 'agent' | 'daemon' | 'system';

export type EventActor = {
  type: ActorType;
  id: string;
};

export type EventType =
  | 'project.created'
  | 'task.created'
  | 'task.updated'
  | 'session.created'
  | 'session.started'
  | 'session.progressed'
  | 'run.created'
  | 'run.failed'
  | 'run.completed'
  | 'tool.requested'
  | 'permission.required'
  | 'tool.completed'
  | 'hook.executed'
  | 'checkpoint.created'
  | 'artifact.created'
  | 'daemon.heartbeat'
  | 'daemon.disconnected'
  | 'audit.recorded';

export type EventEnvelope<TPayload = unknown> = {
  eventId: EventId;
  eventType: EventType;
  payloadVersion: number;
  sequence: number;
  traceId: string;
  projectId: ProjectId;
  taskId?: TaskId;
  sessionId?: SessionId;
  runId?: RunId;
  actor: EventActor;
  occurredAt: string;
  payload: TPayload;
};
