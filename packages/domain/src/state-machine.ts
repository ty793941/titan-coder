import { DomainError } from '@titan/contracts';
import type { ExecutionStatus, TaskStage } from './entities.js';

const taskTransitions: Record<TaskStage, Record<string, TaskStage>> = {
  questions: { 'start-research': 'research' },
  research: { 'approve-research': 'design', 'request-changes': 'questions' },
  design: { 'approve-design': 'structure', 'request-changes': 'research' },
  structure: { 'approve-structure': 'plan', 'request-changes': 'design' },
  plan: { 'approve-plan': 'implement', 'request-changes': 'structure' },
  implement: { 'tests-passed': 'verify', 'request-changes': 'implement' },
  verify: { 'request-review': 'review', 'request-changes': 'implement' },
  review: { approve: 'delivered', 'request-changes': 'implement' },
  delivered: {},
};

const executionTransitions: Record<ExecutionStatus, Record<string, ExecutionStatus>> = {
  queued: { start: 'starting', cancel: 'cancelled' },
  starting: { started: 'running', cancel: 'cancelled', reconnect: 'reconnecting' },
  running: {
    complete: 'completed', fail: 'failed', cancel: 'cancelled', pause: 'paused',
    'wait-input': 'waiting_input', reconnect: 'reconnecting',
  },
  waiting_input: { resume: 'running', cancel: 'cancelled' },
  paused: { resume: 'running', cancel: 'cancelled' },
  reconnecting: { resume: 'running', fail: 'failed', cancel: 'cancelled' },
  completed: {},
  failed: { retry: 'queued' },
  cancelled: {},
};

export function transitionTask(stage: TaskStage, command: string): TaskStage {
  const nextStage = taskTransitions[stage][command];
  if (!nextStage) {
    throw new DomainError('INVALID_STATE_TRANSITION', `cannot run ${command} from task stage ${stage}`);
  }
  return nextStage;
}

export function transitionExecution(status: ExecutionStatus, command: string): ExecutionStatus {
  const nextStatus = executionTransitions[status][command];
  if (!nextStatus) {
    throw new DomainError('INVALID_STATE_TRANSITION', `cannot run ${command} from execution status ${status}`);
  }
  return nextStatus;
}
