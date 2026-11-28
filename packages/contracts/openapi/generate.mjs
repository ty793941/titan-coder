import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import * as source from '../dist/schemas.js';
import * as orchestration from '../dist/orchestration.js';
import * as proposals from '../dist/work-proposals.js';
import * as collaboration from '../dist/collaboration.js';
import { errorCodes } from '../dist/errors.js';

// 仅用于离线协议工件生成，不注册运行时路由；新增 Zod 类型必须显式支持。
function jsonSchema(schema) {
  const def = schema._def;
  switch (def.typeName) {
    case 'ZodNullable': return { anyOf: [jsonSchema(def.innerType), { type: 'null' }] };
    case 'ZodOptional': return jsonSchema(def.innerType);
    case 'ZodDefault': return { ...jsonSchema(def.innerType), default: def.defaultValue() };
    case 'ZodEffects': return jsonSchema(def.schema);
    case 'ZodUnknown': return {};
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodLiteral': return { type: typeof def.value, const: def.value };
    case 'ZodEnum': return { type: 'string', enum: def.values };
    case 'ZodDiscriminatedUnion': return { oneOf: def.options.map(jsonSchema), discriminator: { propertyName: def.discriminator } };
    case 'ZodString': {
      const result = { type: 'string' };
      for (const check of def.checks) {
        if (check.kind === 'min') result.minLength = Math.max(result.minLength ?? 0, check.value);
        else if (check.kind === 'max') result.maxLength = Math.min(result.maxLength ?? Infinity, check.value);
        else if (check.kind === 'regex') {
          result.pattern = check.regex.source;
          if (check.regex.flags) result['x-pattern-flags'] = check.regex.flags;
        }
        else if (check.kind === 'url') result.format = 'uri';
        else if (check.kind === 'uuid') result.format = 'uuid';
        else if (check.kind === 'datetime') result.format = 'date-time';
        else if (check.kind === 'trim') result['x-trim'] = true;
        else throw new Error(`Unsupported string check: ${check.kind}`);
      }
      return result;
    }
    case 'ZodNumber': {
      const result = { type: 'number' };
      for (const check of def.checks) {
        if (check.kind === 'int') result.type = 'integer';
        else if (check.kind === 'min') result[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
        else if (check.kind === 'max') result[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
        else throw new Error(`Unsupported number check: ${check.kind}`);
      }
      return result;
    }
    case 'ZodArray': return {
      type: 'array', items: jsonSchema(def.type),
      ...(def.minLength ? { minItems: def.minLength.value } : {}),
      ...(def.maxLength ? { maxItems: def.maxLength.value } : {}),
    };
    case 'ZodRecord': return { type: 'object', additionalProperties: jsonSchema(def.valueType) };
    case 'ZodObject': {
      const shape = def.shape();
      return {
        type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, jsonSchema(value)])),
        required: Object.entries(shape).filter(([, value]) => !value.isOptional()).map(([key]) => key),
        additionalProperties: def.unknownKeys !== 'strict',
        ...(def.unknownKeys === 'strip' ? { 'x-unknown-fields': 'stripped' } : {}),
      };
    }
    default: throw new Error(`Unsupported Zod type: ${def.typeName}`);
  }
}

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const id = { type: 'string', minLength: 1, maxLength: 200 };
const text = { type: 'string' };
const date = { type: 'string', format: 'date-time' };
const positive = { type: 'integer', exclusiveMinimum: 0 };
const bool = { type: 'boolean' };
const array = items => ({ type: 'array', items });
const object = (properties, required = Object.keys(properties), strict = true) => ({ type: 'object', properties, required, additionalProperties: !strict });
const schemas = Object.fromEntries(Object.entries({
  ProjectCreateRequest: source.projectCreateRequestSchema.partial({ idempotencyKey: true }),
  TaskCreateRequest: source.taskCreateRequestSchema,
  SessionCreateRequest: source.sessionCreateRequestSchema.partial({ idempotencyKey: true }),
  RunCreateRequest: source.runCreateRequestSchema.partial({ idempotencyKey: true }),
  ExecutionConfig: source.executionConfigSchema,
  CloudSnapshotManifest: source.cloudSnapshotManifestSchema,
  HandoffCreateRequest: source.handoffCreateRequestSchema.partial({ idempotencyKey: true }),
  HandoffSnapshotRequest: source.handoffSnapshotRequestSchema,
  HandoffFailureRequest: source.handoffFailureRequestSchema,
  CloudLifecycleRequest: source.cloudLifecycleRequestSchema,
  ExecutionCheckpoint: source.executionCheckpointSchema,
  RunProgress: source.runProgressSchema,
  CloudProgressFence: source.cloudProgressFenceSchema,
  ProgressOutput: source.progressOutputSchema,
  ArtifactWriteOutput: source.artifactWriteOutputSchema,
  DaemonRegistration: source.daemonRegistrationSchema,
  DaemonEventRequest: source.daemonEventSchema,
  Artifact: source.artifactSchema,
  EventEnvelope: source.eventEnvelopeSchema,
  BackgroundJobCreateRequest: orchestration.backgroundJobCreateRequestSchema,
  BackgroundJob: orchestration.backgroundJobSchema,
  JobObservation: orchestration.jobObservationSchema,
  JobExecution: orchestration.jobExecutionSchema,
  ScheduleCreateRequest: orchestration.scheduleCreateRequestSchema,
  ScheduleUpdateRequest: orchestration.scheduleUpdateRequestSchema,
  ScheduleVersionRequest: orchestration.scheduleVersionRequestSchema,
  Schedule: orchestration.scheduleSchema,
  ScheduleOccurrenceRequest: orchestration.scheduleOccurrenceRequestSchema,
  ScheduleOccurrenceResult: orchestration.scheduleOccurrenceResultSchema,
  WorkflowCommand: orchestration.workflowCommandSchema,
  WorkflowClaimRequest: orchestration.workflowClaimRequestSchema,
  WorkflowCompleteRequest: orchestration.workflowCompleteRequestSchema,
  WorkflowRetryRequest: orchestration.workflowRetryRequestSchema,
  WorkflowCancelRequest: orchestration.workflowCancelRequestSchema,
  WorkflowFailRequest: orchestration.workflowFailRequestSchema,
  OrchestrationEmptyRequest: orchestration.orchestrationEmptyRequestSchema,
  WorkProposal: proposals.workProposalSchema,
  WorkProposalAcceptRequest: proposals.workProposalAcceptRequestSchema,
  CollaborationMemberRequest: collaboration.collaborationMemberRequestSchema,
  CollaborationAssignmentRequest: collaboration.assignmentCreateRequestSchema,
  CollaborationReviewRequest: collaboration.reviewRequestCreateSchema,
  CollaborationHandoffRequest: collaboration.collaborationHandoffCreateRequestSchema,
  CollaborationVersionRequest: collaboration.collaborationVersionRequestSchema,
  CollaborationReviewDecision: collaboration.collaborationReviewDecisionSchema,
  CollaborationMember: collaboration.collaborationMemberSchema,
  CollaborationAssignment: collaboration.collaborationAssignmentSchema,
  CollaborationWorkItem: collaboration.collaborationWorkItemSchema,
  CollaborationWorkItemDetail: collaboration.collaborationWorkItemDetailSchema,
  CollaborationReview: collaboration.collaborationReviewSchema,
  CollaborationHandoff: collaboration.collaborationHandoffSchema,
  CollaborationInbox: collaboration.collaborationInboxSchema,
  CollaborationInboxListItem: collaboration.collaborationInboxListItemSchema,
}).map(([key, value]) => [key, jsonSchema(value)]));

schemas.SessionCreateRequest.properties.execution = ref('ExecutionConfig');
schemas.WorkProposal.description = '严格业务草稿：不包含模型Prompt、工具权限、执行配置、凭证或服务URL；各文本字段应用敏感模式校验。JSON解析并按此字段顺序规范化后计算UTF-8 SHA-256。';
schemas.SessionCreateRequest.description = 'execution 可省略；真实执行必须提供最新已批准 Plan 的 planHash。daemonId 如提供，必须与 execution.daemonId 一致。';
schemas.RunCreateRequest.description = '供创建 Run 与恢复 paused Run 共用。checkpointId、planHash 均可省略，显式 checkpointId 必须属于同一 Session。resume 未指定 checkpointId 时选取源 Run 最新检查点，没有检查点则创建无检查点的新尝试；旧 Run 保持 paused。inputSnapshotId 当前仅被接受，不持久化、不恢复上下文。';
schemas.ExecutionConfig.properties.credentialRef.description = '本机凭证引用；只允许引用，不允许模型 API Key 明文。';
schemas.ExecutionConfig.description = 'environmentType 省略按 local 处理，保留 baseUrlRef。local 工作区须位于 Daemon 注册根目录；cloud 仅由 Handoff 创建，使用 /workspace/session 虚拟路径与 snapshot://、lease:// 引用，要求 runtime 及 cloud-session/container/snapshot-transfer/secret-lease 能力。条件通过 validateExecutionConfig 检查，基础 Schema 保留 ZodObject。';
schemas.ExecutionConfig.allOf = [{ if: { properties: { environmentType: { const: 'cloud' } }, required: ['environmentType'] }, then: { required: ['snapshotManifestRef', 'secretLeaseRef'], properties: { workspacePath: { const: '/workspace/session' } } } }];
schemas.ExecutionCheckpoint.properties.successfulTools.items.required.push('output');
schemas.ExecutionCheckpoint.description = '恢复记录；控制面脱敏后 JSON 的 UTF-8 字节大小不得超过 1 MiB。output 必须存在，可以为任意 JSON 值（含 null）。';
// JSON Schema pattern 没有 JS 的 i 标记，需要显式覆盖现有引用正则的大小写集合。
schemas.ArtifactWriteOutput.properties.reference.pattern = '^[aA][rR][tT][iI][fF][aA][cC][tT]://[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/.+$';
schemas.RunProgress.properties.checkpoint = ref('ExecutionCheckpoint');
schemas.RunProgress.allOf = [{ if: { properties: { type: { const: 'checkpoint' } }, required: ['type'] }, then: { required: ['checkpoint'] } }];
schemas.RunProgress.description = 'claimToken 是领取任务的租约证明，不是模型凭证。sequence 在单个 execution_job 内从 1 连续递增；eventId 全局唯一；payload.source 存在时需符合 ProgressOutput。';
schemas.RunProgress['x-output-schema'] = ref('ProgressOutput');
schemas.CloudProgressFence.oneOf = [
  { properties: { jobStatus: { const: 'blocked' }, runStatus: { const: 'reconnecting' } } },
  { properties: { jobStatus: { const: 'cancelled' }, runStatus: { const: 'cancelled' } } },
];
schemas.CloudProgressFence.description = '只允许cloud隔离后的blocked/reconnecting或cancelled/cancelled配对状态。daemonId、runId、eventId必须与本地待发送事件逐项匹配；证明仅用于私有Outbox审计丢弃，不表示控制面接收事件。';
schemas.EventEnvelope.required.push('payload');
schemas.EventEnvelope.properties.actor = ref('Actor');
schemas.EventEnvelope.properties.sequence.maximum = Number.MAX_SAFE_INTEGER;

Object.assign(schemas, {
  Actor: object({ type: { type: 'string', enum: ['user', 'agent', 'daemon', 'system'] }, id }),
  ExecutionStatus: jsonSchema(source.executionStatusSchema),
  Project: object({ id, name: text, goal: text, createdAt: date, version: positive }),
  Task: object({ id, projectId: id, title: text, goal: text, acceptanceCriteria: array(text), priority: jsonSchema(source.prioritySchema),
    stage: jsonSchema(source.taskStageSchema), status: { type: 'string', enum: ['active', 'blocked', 'paused', 'cancelled', 'failed', 'completed'] }, version: positive, createdAt: date }),
  WorkProposalAcceptance: object({ sourceTurnId: { type: 'string', format: 'uuid' }, proposalChecksum: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, task: ref('Task'), artifact: ref('Artifact') }),
  Session: object({ id, taskId: id, status: ref('ExecutionStatus'), entryAgent: { type: 'string', const: 'project-manager' }, planHash: id, createdAt: date, environmentType: { type: 'string', enum: ['local', 'cloud'] }, parentSessionId: id },
    ['id', 'taskId', 'status', 'entryAgent', 'createdAt']),
  Run: object({ id, sessionId: id, attempt: positive, status: ref('ExecutionStatus'), checkpointId: id, errorCode: text, createdAt: date },
    ['id', 'sessionId', 'attempt', 'status', 'createdAt']),
  ArtifactCreateRequest: jsonSchema(z.object({
    type: source.artifactTypeSchema, content: z.string().max(1048576),
    sourceArtifacts: z.array(z.string().trim().min(1).max(200)).max(50).optional(), sessionId: z.string().trim().min(1).max(200).optional(),
  }).strict()),
  StageRequest: jsonSchema(z.object({ stage: z.enum(['research', 'design', 'structure', 'plan', 'implement']), expectedVersion: z.number().int().positive().max(2147483646) }).strict()),
  DaemonHeartbeatRequest: jsonSchema(z.object({ sequence: z.number().int().positive().safe().optional(), daemonId: z.string().optional(), occurredAt: z.string().datetime().optional() }).strict()),
  ClaimRequest: object({}),
  FailRequest: object({ errorCode: { default: 'TOOL_EXECUTION_FAILED', description: '无运行时类型校验；调用者应使用字符串。null 同缺省值。' } }, [], false),
  RunDispatch: object({ jobId: id, runId: id, sessionId: id, taskId: id, projectId: id, goal: text, planHash: id,
    config: ref('ExecutionConfig'), claimToken: { type: 'string', pattern: '^[a-f0-9]{64}$' }, checkpoint: ref('ExecutionCheckpoint'), cloud: ref('CloudDispatch') },
    ['jobId', 'runId', 'sessionId', 'taskId', 'projectId', 'goal', 'planHash', 'config', 'claimToken']),
  ProgressAck: object({ accepted: bool, status: ref('ExecutionStatus'), cancelRequested: bool }),
  RunControl: object({ cancelRequested: bool, status: ref('ExecutionStatus') }),
  ExecutionJob: object({ jobId: id, runId: id, status: { type: 'string', enum: ['queued', 'claimed', 'blocked', 'paused', 'completed', 'failed', 'cancelled', 'waiting_input'] },
    cancelRequested: bool, lastSequence: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, leaseExpiresAt: { type: ['string', 'null'], format: 'date-time' } }),
  DaemonView: object({ daemonId: id, machineName: id, environmentType: { type: 'string', enum: ['local', 'cloud'] }, capabilities: array(id), workspaceRoots: array(text),
    maxConcurrentSessions: positive, daemonVersion: id, status: { type: 'string', enum: ['registered', 'connecting', 'ready', 'draining', 'reconnecting', 'disconnected', 'revoked'] }, lastHeartbeatAt: date }),
  DaemonRegistrationResponse: { allOf: [ref('DaemonView'), object({ authToken: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '注册返回一次的 Daemon 认证令牌；后续使用 Authorization Bearer。禁止记录到普通日志或快照。' } }, ['authToken'], false)] },
  DaemonEventAck: object({ created: bool }),
  DaemonStoredEvent: object({ eventId: id, sequence: { ...positive, maximum: Number.MAX_SAFE_INTEGER }, eventType: id, payload: {}, status: text }),
  ApiError: object({ code: { type: 'string', enum: [...errorCodes, 'INTERNAL_ERROR'] }, message: text, details: { type: 'object', additionalProperties: true }, traceId: text, retryable: bool, occurredAt: date }),
  StreamError: object({ code: { type: 'string', enum: ['EVENT_SEQUENCE_GAP', 'INTERNAL_ERROR'] }, message: text, retryable: bool }),
  CloudDispatch: object({ executionId: id, snapshot: ref('CloudSnapshotManifest'), secretLeaseId: id, secretLeaseExpiresAt: date }),
  CloudLifecycleAck: object({ executionId: id, status: jsonSchema(source.cloudExecutionStatusSchema), secretConsumed: bool, leaseExpiresAt: date }),
  Handoff: object({ id, taskId: id, sourceSessionId: id, sourceRunId: id, targetSessionId: { type: ['string', 'null'] }, checkpointId: id, status: { type: 'string', enum: ['requested', 'starting', 'completed', 'failed'] }, requestedBy: { type: 'string', const: 'local-user' }, workspaceSync: object({ mode: { type: 'string', enum: ['git-snapshot', 'git-patch'] } }), manifest: { anyOf: [ref('CloudSnapshotManifest'), { type: 'null' }] }, errorCode: { type: ['string', 'null'] }, createdAt: date, completedAt: { type: ['string', 'null'], format: 'date-time' }, version: positive }),
  PendingHandoffs: object({ requests: { ...array(object({ id, sourceSessionId: id, sourceRunId: id, checkpointId: id, workspacePath: text, baseRevision: text }, ['id', 'sourceSessionId', 'sourceRunId', 'checkpointId', 'workspacePath'])), maxItems: 100 } }),
  CloudExecution: object({ id, sessionId: id, runId: id, daemonId: id, handoffId: { type: ['string', 'null'] }, status: jsonSchema(source.cloudExecutionStatusSchema), containerId: { type: ['string', 'null'] }, attempt: positive, errorCode: { type: ['string', 'null'] }, leaseExpiresAt: { type: ['string', 'null'], format: 'date-time' }, lastHeartbeatAt: { type: ['string', 'null'], format: 'date-time' }, createdAt: date, endedAt: { type: ['string', 'null'], format: 'date-time' }, version: positive }),
  CloudCancelRequest: jsonSchema(z.object({ idempotencyKey: z.string().trim().min(1).max(200).optional() }).strict()),
});
// allOf 的基类需允许注册响应扩展字段。
schemas.DaemonView.additionalProperties = true;
schemas.ArtifactCreateRequest.properties.sourceArtifacts.uniqueItems = true;
schemas.ArtifactCreateRequest.description = 'sourceArtifacts 必须唯一且全部属于同一 Task，sessionId 必须属于该 Task。content 上限为字符数；服务端 HTTP body 上限独立生效。';
schemas.ArtifactCreateRequest.description += ' 禁止普通创建接口关联cloud Session，云端工件只通过认证Daemon progress登记。';
schemas.StageRequest.description = '仅允许相邻 QRSPI 阶段推进；要求 active Task、expectedVersion 匹配，以及每个准备阶段最新版本 Artifact 的批准与来源链。';
schemas.DaemonHeartbeatRequest.description = '正文可省略；daemonId 若提供须等于路径 daemonId。sequence 与 occurredAt 当前仅校验，不用于心跳去重，服务端采用收到时间。';
schemas.DaemonEventRequest.description = 'daemonId 可省略，提供时须匹配路径；(daemonId,eventId) 重复返回 created=false，当前不比较重复事件正文，也不要求 sequence 连续。';
schemas.FailRequest.description = '仅用于无 execution_job 的 Run；errorCode 无 Zod 运行时校验，按字符串使用，缺省或 null 时使用 TOOL_EXECUTION_FAILED。';
schemas.ConsoleExecutionConfig = jsonSchema(source.executionConfigSchema.omit({ credentialRef: true }));
schemas.ConsoleSession = object({ id, taskId: id, status: ref('ExecutionStatus'), planHash: id,
  execution: ref('ConsoleExecutionConfig'), createdAt: date }, ['id', 'taskId', 'status', 'createdAt']);
schemas.ConsoleDaemonView = { ...schemas.DaemonView, additionalProperties: false };
schemas.ConsoleState = object({
  projects: { ...array(ref('Project')), maxItems: 100 }, tasks: { ...array(ref('Task')), maxItems: 100 },
  sessions: { ...array(ref('ConsoleSession')), maxItems: 100 }, runs: { ...array(ref('Run')), maxItems: 100 },
  daemons: { ...array(ref('ConsoleDaemonView')), maxItems: 100 },
});
schemas.ArtifactContent = object({ content: text, format: { type: 'string', enum: ['markdown', 'json', 'text'] },
  checksum: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, bytes: { type: 'integer', minimum: 0, maximum: 2097152 } });
schemas.BackgroundJobCreateRequest.oneOf = [
  { properties: { kind: { const: 'run' } }, not: { required: ['runId'] } },
  { properties: { kind: { const: 'observe' } }, required: ['runId'] },
];
schemas.BackgroundJobCreateRequest.description = '显式runInBackground=true。run仅接受具备最新批准计划与执行配置的local Session；observe必须指定同Session既有Run，允许local/cloud，仅追踪该Run，不创建新attempt或凭证租约。deadlineAt必须为未来24小时内UTC时间；创建只持久化pending_dispatch与start_job命令，不提前创建execution_job。幂等键按Session隔离，同键异正文409。';
for (const name of ['ScheduleCreateRequest', 'ScheduleUpdateRequest', 'Schedule']) {
  schemas[name].oneOf = [{ required: ['cron'], not: { required: ['intervalSeconds'] } }, { required: ['intervalSeconds'], not: { required: ['cron'] } }];
  schemas[name].properties.timezone['x-validation'] = 'IANA timezone accepted by Intl.DateTimeFormat';
  schemas[name].properties.cron['x-validation'] = 'exactly five numeric cron fields; each field permits *, numeric range/list and positive step within its range';
  schemas[name].description = 'cron与intervalSeconds恰有一个，五字段cron最短一分钟；endsAt严格晚于startsAt。maxRuns为1..100且仅在派发事务成功创建Run时消耗；版本更新不重置计数。enabled创建固定false，启用/暂停/完整定义更新要求expectedVersion。catchup默认60秒，10..3600秒；超过10秒的投递延迟视为补投，在接纳时以行锁设置now+catchupWindowSeconds的恢复窗口，窗口内最多一次；普通10秒内延迟不消耗补投窗口。每次接纳及派发重新校验启用、版本、Plan、Daemon授权和Session并发；旧定义、重叠、超限、窗口外均skipped，计划或权限失效禁用并写事件。';
}
schemas.JobObservation.description = 'Temporal可接收的最小业务观察，严格字段白名单；errorCode仅允许固定平台错误码，禁止错误正文、Prompt、凭证、URL及Checkpoint。paused Run映射waiting_input；不会自动重执行或复用cloud租约。';
schemas.JobExecution.description = '仅供Dispatcher读取的执行标识，不作为Activity返回值进入历史。严格只含jobId、workflowId、workflowVersion=1；核对Session/Task/Project、同Session Run和Schedule occurrence绑定。普通任务为titan/background/<jobId>/v1，调度任务返回持久化occurrenceId，不允许用jobId推导调度Workflow。';
schemas.JobExecution.properties.workflowId['x-validation'] = 'opaque workflow identifier, never a URL (:// is forbidden)';

const json = schema => ({ 'application/json': { schema } });
const response = (description, schema) => ({ description, ...(schema ? { content: json(schema) } : {}) });
const errorResponse = { $ref: '#/components/responses/Error' };
const paths = {};
function operation(method, path, operationId, summary, options = {}) {
  const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: { type: 'string', minLength: 1 } }));
  parameters.push({ $ref: '#/components/parameters/TraceId' }, ...(options.parameters ?? []));
  if (options.idempotency !== undefined) parameters.push({ $ref: `#/components/parameters/${options.idempotency ? 'IdempotencyKey' : 'ArtifactIdempotencyKey'}` });
  const responses = { ...options.responses, '400': errorResponse, '404': errorResponse, '409': errorResponse, '500': errorResponse };
  if (options.auth) responses['401'] = errorResponse;
  if (options.auth || options.forbidden) responses['403'] = errorResponse;
  paths[path] ??= {};
  paths[path][method] = {
    operationId, summary, description: options.description ?? summary,
    security: options.auth === 'console' ? [{ ConsoleBearer: [] }] : options.auth === 'workflow' ? [{ WorkflowBearer: [] }] : options.auth ? [{ DaemonBearer: [] }] : [], parameters,
    ...(options.body ? { requestBody: { required: options.bodyRequired !== false, content: json(ref(options.body)) } } : {}),
    responses,
    ...(options.idempotency !== undefined ? { 'x-idempotency-required': options.idempotency } : {}),
    ...(options.extensions ?? {}),
  };
}
const create = (path, name, body, output, description) => operation('post', path, `create${name}`, `创建 ${name}`, {
  body, bodyRequired: name !== 'Run', idempotency: true, responses: { '201': response('创建或相同幂等请求重放；当前控制器均返回 201。', ref(output)) },
  description: `${description} Idempotency-Key 请求头覆盖正文 idempotencyKey，二者至少有一个非空值；去重作用域见协议说明。`,
});
create('/api/projects', 'Project', 'ProjectCreateRequest', 'Project', '创建本机开发项目。');
create('/api/projects/{projectId}/tasks', 'Task', 'TaskCreateRequest', 'Task', '创建初始 questions 阶段 Task；humanOwner 当前接受但不持久化。');
operation('post', '/api/projects/{projectId}/work-proposals/accept', 'acceptWorkProposal', '确认工作提案并原子创建任务和待审批草稿', {
  auth: 'console', body: 'WorkProposalAcceptRequest',
  description: 'Console Bearer且confirmed=true。规范化提案SHA-256必须与proposalChecksum一致；project行锁下以sourceTurnId固定去重，不使用客户端Idempotency-Key改变来源。相同来源同正文重复返回201及原始结果，异正文409 IDEMPOTENCY_CONFLICT。复用领域服务在同一事务创建questions/active Task及draft/pending questions工件，任何失败回滚任务、工件元数据、事件和幂等记录，不自动审批、推进或创建Run。本机网关从私有历史读取来源；本接口为可信本机客户端的显式确认，不证明模型语义正确。',
  responses: { '201': response('新建或重放同一任务与待审批工件。', ref('WorkProposalAcceptance')) },
});
operation('get', '/api/tasks/{taskId}', 'getTask', '查询 Task', { responses: { '200': response('Task 业务事实。', ref('Task')) } });
operation('get', '/api/tasks/{taskId}/events', 'listTaskEvents', '查询 Task 关联事件', { description: '返回 JSON 数组，按 occurredAt 升序；可能包含多个 Run 各自的序号，不能当成单一 SSE 游标。未知 Task 当前返回空数组。', responses: { '200': response('关联事件数组。', array(ref('EventEnvelope'))) } });
operation('post', '/api/tasks/{taskId}/stage', 'advanceTaskStage', '推进相邻 QRSPI 阶段', { body: 'StageRequest', responses: { '200': response('更新后的 Task，version 加一。', ref('Task')) } });
create('/api/tasks/{taskId}/sessions', 'Session', 'SessionCreateRequest', 'Session', '创建项目经理 Session；execution 可省略，提供时要求最新已批准 planHash、本机可用 Daemon 和 workspace 授权。');
operation('get', '/api/sessions/{sessionId}', 'getSession', '查询 Session', { responses: { '200': response('不包含 execution 配置、goal 或内部 version。', ref('Session')) } });
create('/api/sessions/{sessionId}/runs', 'Run', 'RunCreateRequest', 'Run', '创建新的 Run attempt；恢复使用同一 Session 的 checkpointId，旧 Run 保留。');
operation('get', '/api/runs/{runId}', 'getRun', '查询 Run', { responses: { '200': response('Run 当前状态。', ref('Run')) } });
operation('post', '/api/runs/{runId}/pause', 'pauseRun', '暂停 Run 并请求停止执行', {
  description: '仅 local Run 支持暂停：同步将非终态 Run/Session 标记 paused，已有 execution_job 标记 paused 与 cancelRequested=true，保留持久检查点并产生 run.paused 事件。重复暂停返回同一 Run；completed/failed/cancelled 返回 400 INVALID_STATE_TRANSITION。Daemon 通过 control 轮询停止进程，200 不证明进程已经退出；不是原生模型会话热暂停。cloud Run 在 Console Bearer 认证后始终返回 403 PERMISSION_DENIED，details.reason=CLOUD_PAUSE_UNSUPPORTED，不改变执行状态；需要停止云端执行时使用 cancel。',
  responses: { '200': response('原 local Run 的 paused 业务视图，不创建新 attempt。', ref('Run')), '403': response('cloud pause 返回 PERMISSION_DENIED，details.reason=CLOUD_PAUSE_UNSUPPORTED，retryable=false；不修改 Run、Session、Job、cloud execution、租约、Handoff 或事件。', ref('ApiError')) },
});
operation('post', '/api/runs/{runId}/resume', 'resumeRun', '从 paused Run 创建新尝试', {
  body: 'RunCreateRequest', bodyRequired: false, idempotency: true,
  description: '源 Run 必须 paused；同一 Session 创建新 Run，attempt 递增并置 queued，源 Run 保持 paused。Idempotency-Key 请求头覆盖正文 idempotencyKey，二者至少满足一处，作用域为 run:{runId}:resume；同键同正文重放仍返回 201。checkpointId 可指定同一 Session 的检查点，省略时选源 Run 最新检查点，没有则创建无检查点的新尝试。planHash 可省略但不能绕过 Session 绑定及最新已批准 Plan 校验；已有 queued/starting/running/waiting_input Run 返回 409 VERSION_CONFLICT。按 Session execution 配置重新排队，不恢复原进程或原生模型会话。',
  responses: { '201': response('新 Run 或幂等重放的同一新 Run；旧 paused Run 保留。', ref('Run')) },
  extensions: { 'x-idempotency-scope': 'run:{runId}:resume', 'x-resume-behavior': { createsNewAttempt: true, sourceRunStatus: 'paused', nativeHotResume: false, checkpointFallback: 'latest-on-source-run' } },
});
operation('post', '/api/runs/{runId}/fail', 'failRun', '标记无调度作业的 Run 失败', { body: 'FailRequest', forbidden: true, responses: { '204': response('无正文；真实执行 Run 只能由认证的 Daemon progress 上报失败。') } });
operation('post', '/api/runs/{runId}/complete', 'completeRun', '标记无调度作业的 Run 完成', { forbidden: true, responses: { '204': response('无正文；真实执行 Run 只能由认证的 Daemon progress 上报完成。') } });
operation('post', '/api/runs/{runId}/cancel', 'cancelRun', '请求取消 Run', { description: '同步记录 cancelled 与 cancelRequested，Daemon 轮询 control 后终止进程。已终态 Run 原样返回；响应不证明操作系统进程已经退出。', responses: { '200': response('Run 业务状态。', ref('Run')) } });
operation('post', '/api/tasks/{taskId}/artifacts', 'createArtifact', '创建新版本 Artifact', { body: 'ArtifactCreateRequest', idempotency: false, description: '建议显式提供 Idempotency-Key；省略时控制器生成 artifact-<Date.now()>，不能据此承诺安全重放。正文不接受 idempotencyKey。', responses: { '201': response('新版本 Artifact 或幂等重放。', ref('Artifact')) } });
operation('get', '/api/tasks/{taskId}/artifacts', 'listArtifacts', '列出 Task Artifact', {
  parameters: [{ name: 'resolution', in: 'query', required: false, schema: { type: 'string' }, description: '仅 latest-approved 启用按类型选择最高已批准版本；其他值返回全部，按 createdAt 升序。未知 Task 返回空数组。' }],
  responses: { '200': response('Artifact 数组。', array(ref('Artifact'))) },
});
operation('get', '/api/artifacts/{artifactId}', 'getArtifact', '查询 Artifact', { responses: { '200': response('元数据，不包含文件正文。', ref('Artifact')) } });
operation('get', '/api/artifacts/{artifactId}/content', 'getArtifactContent', '读取已登记 Artifact 正文', {
  auth: 'console',
  description: '需要 TITAN_CONSOLE_TOKEN 对应的 Bearer Token。先读取既有 Artifact 元数据并校验 Project/Task/Session 归属；仅允许控制面仓库 .titan/artifacts 或该 Session execution.workspacePath/.titan/artifacts 内的本地 file URI。控制面文件必须匹配 artifactId-v{version}.md，运行时文件必须匹配 artifact://UUID/logicalPath 引用；禁止借用同目录其他工件文件。realpath 校验文件及工件根目录，打开后再次复核路径与 inode，拒绝符号链接逃逸及目录替换。只读 UTF-8 的 .md/.markdown、.json、.txt/.text/.log；不执行或渲染 HTML。读取上限为 2097152 字节，按原始字节验证 SHA-256。超限返回 400 VALIDATION_FAILED/details.reason=ARTIFACT_CONTENT_TOO_LARGE，details.maxBytes=2097152；校验和不符返回 409 VERSION_CONFLICT/details.reason=ARTIFACT_CHECKSUM_MISMATCH；格式或编码不支持返回 400，越界返回 403，元数据或文件缺失返回 404。',
  responses: { '200': response('正文、扩展名对应格式、已核对的校验和及 UTF-8 字节数。', ref('ArtifactContent')) },
});
operation('get', '/api/console/state', 'getConsoleState', '读取本机控制台业务状态', {
  auth: 'console',
  description: '需要 TITAN_CONSOLE_TOKEN 对应的 Bearer Token；未配置或不匹配返回 401。只读 PostgreSQL 持久事实；每个数组默认最多 100 条，limit 对所有数组生效，以 createdAt 降序、id 升序稳定排序，无游标。子实体仅查询本次返回父实体的 ID；选 Task 时其父 Project 和子 Session/Run 同步限定；未知 Project/Task 或二者不匹配返回 404 RESOURCE_NOT_FOUND。Daemon 为本机公共元数据，不随任务筛选，仅 environmentType=local；状态按心跳时间计算。execution 省略 credentialRef 及任意未声明字段，不包含权限快照、authToken、claimToken 或原始凭证。未知查询参数返回 400。',
  parameters: [
    ...['projectId', 'taskId'].map(name => ({ name, in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' } })),
    { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 } },
  ],
  responses: { '200': response('批量读取且字段经过白名单映射的项目、任务、会话、运行与本机 Daemon。', ref('ConsoleState')) },
});
operation('post', '/api/artifacts/{artifactId}/approve', 'approveArtifact', '批准最新 QRSPI 准备工件', { description: '仅 questions/research/design/structure/plan 的最新版本可批准；重复批准已批准版本直接返回。记录审批事件及审计；不等同于阶段推进。', responses: { '200': response('已批准 Artifact。', ref('Artifact')) } });
operation('get', '/api/runs/{runId}/events', 'streamRunEvents', '重放或跟随 Run SSE', {
  description: 'Last-Event-ID 为 Run 事件 sequence（非 eventId），缺省 0；从其后重放。仅 follow=true 持续轮询（250ms），空闲约 15s 注释心跳。id 为 sequence，event 为 eventType，data 为 EventEnvelope JSON。起流前返回 ApiError；起流后异常以 stream.error 数据帧结束，不能改 HTTP 状态。',
  parameters: [{ $ref: '#/components/parameters/LastEventId' }, { name: 'follow', in: 'query', required: false, schema: { type: 'string' }, description: '仅字符串 true 开启持续跟随；省略或其他值仅重放后关闭。' }],
  responses: { '200': { description: 'text/event-stream；注释 connected/heartbeat 不推进游标。', headers: {
    'Cache-Control': { schema: { type: 'string', const: 'no-cache' } }, 'X-Accel-Buffering': { schema: { type: 'string', const: 'no' } },
  }, content: { 'text/event-stream': { schema: { type: 'string' }, example: 'id: 1\nevent: run.created\ndata: {"eventId":"evt_1","eventType":"run.created","payloadVersion":1,"sequence":1,"traceId":"trace_1","projectId":"project_1","runId":"run_1","actor":{"type":"system","id":"control-plane"},"occurredAt":"2026-11-21T00:00:00.000Z","payload":{}}\n\n' } } } },
  extensions: { 'x-sse-data-schema': ref('EventEnvelope'), 'x-sse-error-schema': ref('StreamError') },
});
operation('post', '/api/daemons/register', 'registerDaemon', '注册 Daemon', { body: 'DaemonRegistration', description: '本机开发入口当前不要求 Bearer；每次调用创建新 daemonId 与令牌，不支持 Idempotency-Key 去重。cloud 执行要求 runtime 及四项云端能力、ready 心跳和容量。', responses: { '201': response('Daemon 元数据及一次性返回的 authToken。', ref('DaemonRegistrationResponse')) } });
operation('get', '/api/daemons/{daemonId}', 'getDaemon', '查询 Daemon 状态', { description: '当前公开读取本机元数据。lastHeartbeatAt 距今超过 30s 显示 reconnecting、超过 90s 显示 disconnected；revoked 优先。', responses: { '200': response('不含认证令牌或哈希。', ref('DaemonView')) } });
operation('post', '/api/daemons/{daemonId}/heartbeat', 'heartbeatDaemon', '更新 Daemon 心跳', { auth: true, body: 'DaemonHeartbeatRequest', bodyRequired: false, responses: { '200': response('服务端接收时间与 ready 状态。', ref('DaemonView')) } });
operation('post', '/api/daemons/{daemonId}/revoke', 'revokeDaemon', '撤销当前认证 Daemon', { auth: true, responses: { '204': response('无正文；后续认证返回 PERMISSION_DENIED。') } });
operation('post', '/api/daemons/{daemonId}/events', 'appendDaemonEvent', '接收 Daemon 通用 Outbox 事件', { auth: true, body: 'DaemonEventRequest', responses: { '201': response('首次接收，created=true。', ref('DaemonEventAck')), '200': response('重复 (daemonId,eventId)，created=false。', ref('DaemonEventAck')) } });
operation('get', '/api/daemons/{daemonId}/events', 'listDaemonEvents', '查询通用 Outbox 接收记录', { auth: true, responses: { '200': response('按 sequence 升序；当前不驱动 Run 状态机。', array(ref('DaemonStoredEvent'))) } });
operation('post', '/api/daemons/{daemonId}/claim', 'claimRun', '领取一个 Run 调度作业', { auth: true, body: 'ClaimRequest', bodyRequired: false, description: '空正文或 {}；ready Daemon 按容量领取 queued 作业并获取 120s 租约。过期租约在后续 claim 扫描时转人工恢复；不自动重放工具。', responses: { '200': response('包含租约 claimToken 的 RunDispatch。', ref('RunDispatch')), '204': response('无可领取作业或已达容量，无正文。') } });
operation('post', '/api/daemons/{daemonId}/runs/{runId}/progress', 'reportRunProgress', '上报 Run 进度与检查点', { auth: true, body: 'RunProgress', description: '要求 Daemon Bearer 与正文 claimToken，校验 job 归属、有效租约、连续进度序号。eventId 相同且规范化正文相同返回 accepted=false，不重复推进；不同正文或跨 job 复用返回 409。认证及领取证明有效时，paused Run 的迟到进度返回 accepted=false/status=paused/cancelRequested=true，不覆盖暂停状态；已被过期处理清除的领取证明仍会被拒绝。', responses: { '200': response('确认接收及取消标记；paused 或终态进度可能 accepted=false。', ref('ProgressAck')) } });
operation('get', '/api/daemons/{daemonId}/runs/{runId}/control', 'getRunControl', '轮询取消或暂停停止信号与 Run 状态', { auth: true, description: '暂停复用 cancelRequested=true 并返回 status=paused，请求 Daemon 停止进程。ready Daemon 对有效 claimed 作业的轮询会续租 120s；paused 作业不续租。resume 通过用户侧 REST 创建新 Run，不在此轮询中热恢复。', responses: { '200': response('停止标记和 Run 状态。', ref('RunControl')) } });
operation('get', '/api/daemons/{daemonId}/runs/{runId}/job', 'getExecutionJob', '查询调度作业及进度游标', { auth: true, responses: { '200': response('Daemon 归属校验后的作业元数据，不含 claimToken。', ref('ExecutionJob')) } });

operation('post', '/api/sessions/{id}/handoff', 'requestHandoff', '请求本机到云端交接', { auth: 'console', body: 'HandoffCreateRequest', idempotency: true, description: 'Console Bearer 认证后以 local-user 记账。源 Session 与 checkpoint 所属 Run 必须 paused，checkpoint 必须为源 Run 当前检查点。仅创建 requested，不访问文件、不创建目标 Session。同键同请求返回原响应，异正文 409；请求头 Idempotency-Key 优先。', responses: { '201': response('新 requested Handoff。', ref('Handoff')), '200': response('幂等重放。', ref('Handoff')) } });
operation('get', '/api/handoffs/{id}', 'getHandoff', '查询交接事实', { auth: 'console', responses: { '200': response('交接与清单元数据。', ref('Handoff')) } });
operation('get', '/api/daemons/{id}/handoffs/pending', 'pendingHandoffs', '领取源 Daemon 待导出交接', { auth: true, description: '仅返回当前认证源 Daemon 的 requested，最多100条；workspacePath 来自已授权源 Session，baseRevision 可省略。', responses: { '200': response('待导出的请求。', ref('PendingHandoffs')) } });
operation('post', '/api/daemons/{id}/handoffs/{handoffId}/snapshot', 'acknowledgeHandoffSnapshot', '确认停止并登记 Snapshot 清单', { auth: true, body: 'HandoffSnapshotRequest', description: 'stopped:true 表示源 Worker 已停止且本地 Outbox 已排空，由源 Daemon 负责真实性。CP 不读取文件；验证 paused 和 checkpoint 归属后选有容量的 ready cloud Daemon，原子创建子 Session、新 Run、新 checkpoint、job、执行与一次性5分钟 Secret Lease。只导入消息，工具结果与 evidence 清空。重复相同 manifest 返回原目标；不同清单409。snapshot://snapshotId 由共享传输根解析，不含宿主路径。', responses: { '200': response('starting Handoff 或相同清单重放。', ref('Handoff')) } });
operation('post', '/api/daemons/{id}/handoffs/{handoffId}/failure', 'failRequestedHandoff', '源Daemon上报交接准备失败', { auth: true, body: 'HandoffFailureRequest', description: '只允许认证的源Daemon关闭尚未创建目标的requested Handoff。errorCode仅允许HANDOFF_SNAPSHOT_FAILED、HANDOFF_TRANSFER_FAILED、HANDOFF_TARGET_UNAVAILABLE，不接受错误文本或路径。原子写failed、completedAt、version和handoff.failed Outbox事件；相同失败重放200且不重复事件，改错误码409，已创建目标400；保留源Session/Run状态。', responses: { '200': response('failed Handoff或相同失败重放。', ref('Handoff')) } });
operation('post', '/api/daemons/{id}/runs/{runId}/cloud', 'reportCloudLifecycle', '上报独立容器生命周期与消费租约', { auth: true, body: 'CloudLifecycleRequest', description: '校验 Daemon Bearer、job归属、claimToken、双执行租约及状态转移。consumeSecret:true 以CAS单次消费Secret Lease，重复409，不返回Secret。生命周期不修改Run状态，不占用RunProgress.sequence。容器ID首次登记后不可改变。', responses: { '200': response('生命周期及消费确认。', ref('CloudLifecycleAck')) } });
operation('get', '/api/cloud-executions/{id}', 'getCloudExecution', '查询云端执行并核对失联事实', { auth: 'console', description: '观察到失联或租约过期时将claimed作业隔离为blocked、Session/Run标记reconnecting、撤销凭证租约，保留容器最后已知状态；不会自动重执行。', responses: { '200': response('不含凭证或claimToken的执行事实。', ref('CloudExecution')) } });
operation('post', '/api/cloud-executions/{id}/cancel', 'cancelCloudExecution', '幂等取消云端执行', { auth: 'console', body: 'CloudCancelRequest', bodyRequired: false, idempotency: false, description: 'Console Bearer；正文为空或仅idempotencyKey，请求头可提供Idempotency-Key。以终态天然幂等，在同一事务更新Run/Session/job/cloud/Handoff、撤销Secret Lease并写Outbox。响应不证明容器已经停止。', responses: { '200': response('当前云端执行事实。', ref('CloudExecution')) } });

for (const action of ['pause', 'resume', 'cancel']) {
  const operation = paths[`/api/runs/{runId}/${action}`].post;
  operation.description += ' 对cloud Session的调用额外要求Console Bearer；local行为保持兼容。cloud不允许通过resume自动重新执行，必须人工处理后发起新的授权交接。';
  operation['x-cloud-security'] = [{ ConsoleBearer: [] }];
  operation.responses['401'] = errorResponse;
}
paths['/api/daemons/{daemonId}/runs/{runId}/control'].get.description += ' cloud同时续期job和cloud_execution的120秒租约；任一过期或Daemon失联则隔离为blocked并持久标记reconnecting，停止信号为true。Secret Lease固定有效期不续期。';
paths['/api/daemons/{daemonId}/runs/{runId}/progress'].post.description += ' cloud终态同步执行和Handoff；waiting_input保留Run等待状态，但容器尝试标记failed、撤销凭证租约。容器生命周期由独立cloud接口上报，保持七种progress类型。';
paths['/api/daemons/{daemonId}/runs/{runId}/progress'].post.description += ' cloud还要求daemonStatus=ready；认证及领取证明有效但心跳失联时，即使执行租约未过期也拒收progress，先提交blocked/reconnecting、清除领取证明和租约、撤销Secret Lease及Outbox事实，再返回403 PERMISSION_DENIED，不续租、不完成Run。local保持既有行为。';
paths['/api/daemons/{daemonId}/runs/{runId}/progress'].post.description += ' 已隔离cloud执行在后续用户取消后仍可返回受限CLOUD_PROGRESS_FENCED details：要求job取消标记为true、claim hash与lease均已清除、Run保留CLOUD_WORKER_DISCONNECTED，并核对同一Daemon/Session/Run的cloud_execution持久失联原因和空租约。仅blocked/reconnecting及cancelled/cancelled配对可提供证明；普通错误token、未隔离取消、其他Daemon作业不提供。客户端只可审计丢弃daemonId/runId/eventId完全匹配的事件，任意403不能触发丢弃。';
paths['/api/daemons/{daemonId}/runs/{runId}/progress'].post['x-fence-details-schema'] = ref('CloudProgressFence');
paths['/api/daemons/{id}/handoffs/{handoffId}/snapshot'].post.description += ' 创建目标前锁定源Session，要求sourceRun为attempt最大的最新Run且该Session没有queued/starting/running/waiting_input/reconnecting Run；源Session/Run仍须paused且checkpoint未变，旧Run再次paused不能绕过此校验。源状态或checkpoint失效时，先原子持久化Handoff failed、errorCode=HANDOFF_CHECKPOINT_INVALID、completedAt、version递增和handoff.failed Outbox事件，释放active Handoff并从pending移除，再返回400 HANDOFF_CHECKPOINT_INVALID、retryable=false；后续ACK返回409且不重复失败事件。目标暂不可用返回409 HANDOFF_TARGET_UNAVAILABLE、retryable=true，保留requested、版本和pending供重试。manifest.snapshotId为小写UUID，fileCount最多10000、totalBytes最多33554432，baseRevision为40或64位小写十六进制、checksum仅允许sha256:加64位小写十六进制。';
paths['/api/daemons/{daemonId}/runs/{runId}/progress'].post.description += ' cloud工件URI必须已由宿主映射为唯一登记workspaceRoot/sessionId/session/.titan/artifacts/UUID/logicalPath，严格绑定cloud_execution、Session和Daemon；拒绝虚拟容器URI、其他Session路径和多root歧义。checkpoint及结构化tool output均校验，保留artifact://引用与checksum。';
paths['/api/artifacts/{artifactId}/content'].get.description += ' cloud工件仅允许创建来源为所属Daemon、关联真实cloud_execution的记录；宿主根从该Daemon唯一workspaceRoot推导到sessionId/session，读取时校验realpath仍为该根下精确Session目录，拒绝Session目录及工件目录符号链接逃逸。宿主文件需由Executor在容器退出后保留，CP不调用Docker。';

const pageParameters = [
  { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
  { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 } },
];
operation('post', '/api/sessions/{id}/background-jobs', 'createBackgroundJob', '创建已授权后台任务', { auth: 'console', body: 'BackgroundJobCreateRequest', responses: { '201': response('已持久化pending_dispatch；同键同正文重放同一任务。', ref('BackgroundJob')) } });
operation('get', '/api/sessions/{id}/background-jobs', 'listBackgroundJobs', '分页读取同Session后台任务', { auth: 'console', parameters: pageParameters, description: '仅同Session，createdAt倒序、id升序，默认50最多100，offset最多1000000；拒绝未知query字段。', responses: { '200': response('安全后台任务数组。', array(ref('BackgroundJob'))) } });
operation('get', '/api/background-jobs/{id}', 'getBackgroundJob', '读取后台任务', { auth: 'console', responses: { '200': response('业务任务及当前Run观察。', ref('BackgroundJob')) } });
operation('post', '/api/background-jobs/{id}/cancel', 'cancelBackgroundJob', '持久化后台任务取消意图', { auth: 'console', body: 'OrchestrationEmptyRequest', description: '原子记录取消意图并取消同一Run、执行队列与cloud租约，重复保持终态；迟到dispatch不能创建Run。响应不证明进程或容器已退出。', responses: { '200': response('当前后台任务业务状态。', ref('BackgroundJob')) } });
operation('post', '/api/sessions/{id}/schedules', 'createExecutionSchedule', '创建默认禁用的有限次数调度', { auth: 'console', body: 'ScheduleCreateRequest', responses: { '201': response('enabled=false、pending_sync；同键同正文重放。', ref('Schedule')) } });
operation('get', '/api/sessions/{id}/schedules', 'listExecutionSchedules', '分页读取Session调度', { auth: 'console', parameters: pageParameters, responses: { '200': response('同Session安全调度定义数组。', array(ref('Schedule'))) } });
operation('get', '/api/schedules/{id}', 'getExecutionSchedule', '读取安全调度定义', { auth: 'console', responses: { '200': response('不含执行配置、宿主路径或凭证。', ref('Schedule')) } });
for (const action of ['update', 'enable', 'pause']) operation('post', `/api/schedules/{id}/${action}`, `${action}ExecutionSchedule`, `${action}调度定义`, { auth: 'console', body: action === 'update' ? 'ScheduleUpdateRequest' : 'ScheduleVersionRequest', description: 'expectedVersion精确匹配才变更，version加一并原子写sync_schedule命令，ACK当前版本前保持pending_sync；旧版本ACK不能覆盖新定义。update传完整时间/授权定义并保留enabled和已用次数，暂停不取消既有Run。', responses: { '200': response('新版本安全调度定义。', ref('Schedule')) } });
operation('post', '/api/internal/workflow/commands/claim', 'claimWorkflowCommand', '领取Workflow命令投递租约', { auth: 'workflow', body: 'WorkflowClaimRequest', description: 'workerId必须绑定独立Workflow身份，skip locked领取后立即释放事务锁；30秒租约，claimToken只持久化SHA-256，每次重领换token，最多10次尝试。sync_schedule只领取当前definitionVersion，同Schedule有效租约串行互斥；尚未领取或租约过期的旧版本标记completed/errorCode=SCHEDULE_DEFINITION_SUPERSEDED，不推进syncStatus。有效旧租约结束前不领取新版。租约过期不能中断已发送的网络请求，Temporal更新仍需客户端按版本冲突令牌/单调版本进行fencing，禁止旧版本覆盖新版。', responses: { '200': response('固定格式安全命令。', ref('WorkflowCommand')), '204': response('当前没有可领取命令，无正文。') } });
operation('post', '/api/internal/workflow/commands/{id}/complete', 'completeWorkflowCommand', '确认当前投递租约', { auth: 'workflow', body: 'WorkflowCompleteRequest', description: '仅同worker与当前未到期claimToken可首次ACK；过期或旧token返回409 WORKFLOW_COMMAND_LEASE_EXPIRED。成功完成后保留最后一代token摘要，相同worker和claimToken重放返回204且不重新推进同步状态；retry不能重放已完成ACK。', responses: { '204': response('投递已确认，无正文。') } });
operation('post', '/api/internal/workflow/commands/{id}/retry', 'retryWorkflowCommand', '有限退避或停止重试', { auth: 'workflow', body: 'WorkflowRetryRequest', description: '有效租约内retryable=true退避1秒指数增长、最多300秒、最多10次；永久错误或耗尽转failed。只保存固定errorCode。', responses: { '204': response('重试或失败状态已保存，无正文。') } });
operation('get', '/api/internal/workflow/jobs/{id}', 'observeWorkflowJob', '观察同一业务Run', { auth: 'workflow', responses: { '200': response('严格最小观察结构。', ref('JobObservation')) } });
operation('get', '/api/internal/workflow/jobs/{id}/execution', 'getWorkflowJobExecution', '读取后台任务实际Workflow执行标识', { auth: 'workflow', description: '独立WorkflowBearer，仅返回数据库已授权任务的执行标识；服务端解析并核对Project/Task/Session、Run和occurrence归属，不接受客户端传入workflowId。未知资源或归属不一致404，Console/Daemon身份401。Dispatcher用于cancel实际Workflow，此GET不是Activity，不扩展JobObservation。', responses: { '200': response('三个必填安全标识字段。', ref('JobExecution')) } });
operation('post', '/api/internal/workflow/jobs/{id}/dispatch', 'dispatchWorkflowJob', '幂等原子派发业务任务', { auth: 'workflow', body: 'OrchestrationEmptyRequest', description: '同一事务创建Run、execution_job及后台关联和事件；重试返回同一Run。observe不创建attempt。取消/到期先于创建时永不启动；Schedule计数只在此事务占用。', responses: { '200': response('严格最小观察结构。', ref('JobObservation')) } });
operation('post', '/api/internal/workflow/jobs/{id}/cancel', 'cancelWorkflowJob', '按持久截止时间取消业务任务', { auth: 'workflow', body: 'WorkflowCancelRequest', description: 'reason=expired仅服务端deadlineAt已到期可接受；禁止Workflow延长或提前伪造截止时间。持久化取消意图不证明宿主进程已退出。', responses: { '200': response('严格最小观察结构。', ref('JobObservation')) } });
operation('post', '/api/internal/workflow/jobs/{id}/fail', 'failWorkflowJob', '记录后台任务编排失败', { auth: 'workflow', body: 'WorkflowFailRequest', description: '仅允许已绑定workerId的Workflow身份调用。errorCode限平台既有枚举；幂等保留终态，只将后台任务置failed并写background_job.failed事件，不修改Run、Session或execution_job，真实执行仍由Daemon管理。', responses: { '200': response('严格最小观察结构。', ref('JobObservation')) } });
operation('get', '/api/internal/workflow/schedules/{id}', 'getWorkflowSchedule', '读取安全Schedule定义', { auth: 'workflow', responses: { '200': response('安全定义，仅用于同步Temporal Schedule。', ref('Schedule')) } });
operation('post', '/api/internal/workflow/schedules/{id}/occurrences', 'admitScheduleOccurrence', '原子接纳稳定触发', { auth: 'workflow', body: 'ScheduleOccurrenceRequest', description: 'occurrenceId为稳定Temporal Workflow ID且全局唯一，同ID异定义409；同Schedule/版本/计划时间不会重复接纳。同触发重试返回相同结果，创建Job绑定occurrenceId且不再投递start_job命令；不会提前创建execution_job或消耗maxRuns。', responses: { '200': response('created与jobId或skipped。', ref('ScheduleOccurrenceResult')) } });
for (const [path, methods] of Object.entries(paths)) {
  if (/^\/api\/internal\/workflow\/(jobs|schedules)\//.test(path)) {
    for (const operation of Object.values(methods)) operation.description += ' 校验认证身份等于资源持久workerId；未领取或不同Worker返回403，未知或关联归属无效返回404，拒绝前不刷新或改变业务事实。身份在command claim同事务绑定，Schedule occurrence的Job继承相同身份；重启后同workerId不需要命令lease或claimToken进入Workflow历史。';
  }
}
paths['/api/internal/workflow/commands/claim'].post.description += ' 同事务持久绑定目标job/schedule的workerId；已绑定其他Worker的资源不能重领。';
paths['/api/internal/workflow/commands/{id}/retry'].post.description += ' start_job永久失败或10次耗尽且未执行时，原子置后台任务failed/WORKFLOW_COMMAND_FAILED并写事件；已创建Run保持Daemon管理。过期第10次租约在下一claim清理时执行相同收敛。';
paths['/api/background-jobs/{id}'].get.description += ' 到deadline时即使无Run、无Temporal也持久expired、取消意图及cancel_job命令；重复GET不重复事件。';
paths['/api/internal/workflow/jobs/{id}'].get.description += ' 授权后到期检查与Console GET一致。';
schemas.Schedule.description += ' run_count达到maxRuns的同一派发事务禁用Schedule、version加一并enqueue sync_schedule停止未来触发，不取消本次Run；Temporal不得以触发次数替代实际Run计数。';

// 协作管理接口只信任Console，不提供基于客户端主体ID的成员身份模拟。
function collaborationOperation(method, path, name, body, output, list = false, parameters = []) {
  operation(method, path, name, name, {
    auth: 'console', ...(body ? { body } : {}), parameters,
    description: '本机可信Console协作管理，固定操作者local-user。成员引用不等于登录或角色授权，禁止请求自报actor。个人接受/拒绝/评审及我的Inbox仅允许local-user且须为项目active成员；其他主体需要未来独立身份接入。修改不自动推进任务、批准Artifact或启动Run。创建分配/评审/交接必须提供Idempotency-Key或正文idempotencyKey；状态修改使用expectedVersion，完全相同的上一版本重试返回当前结果。所有写入、事件、Outbox及审计处于同一事务。',
    responses: { [method === 'get' || path.match(/\/(accept|decline|complete|approve|request-changes|cancel|read|resolve|dismiss)$/) ? '200' : '201']: response('持久化协作事实；camelCase字段，空时间/引用为null。', list ? array(ref(output)) : ref(output)) },
  });
}
collaborationOperation('post', '/api/tasks/{taskId}/work-item', 'createCollaborationWorkItem', 'OrchestrationEmptyRequest', 'CollaborationWorkItem');
collaborationOperation('post', '/api/projects/{projectId}/members', 'upsertCollaborationMember', 'CollaborationMemberRequest', 'CollaborationMember');
collaborationOperation('get', '/api/projects/{projectId}/members', 'listCollaborationMembers', null, 'CollaborationMember', true);
collaborationOperation('get', '/api/work-items/{workItemId}', 'getCollaborationWorkItem', null, 'CollaborationWorkItemDetail');
collaborationOperation('post', '/api/work-items/{workItemId}/assignments', 'createCollaborationAssignment', 'CollaborationAssignmentRequest', 'CollaborationAssignment');
collaborationOperation('get', '/api/work-items/{workItemId}/assignments', 'listCollaborationAssignments', null, 'CollaborationAssignment', true);
for (const action of ['accept', 'decline', 'complete']) collaborationOperation('post', `/api/assignments/{id}/${action}`, `${action}CollaborationAssignment`, 'CollaborationVersionRequest', 'CollaborationAssignment');
collaborationOperation('post', '/api/review-requests', 'createCollaborationReview', 'CollaborationReviewRequest', 'CollaborationReview');
collaborationOperation('get', '/api/projects/{projectId}/review-requests', 'listCollaborationReviews', null, 'CollaborationReview', true);
for (const action of ['approve', 'request-changes', 'cancel']) collaborationOperation('post', `/api/review-requests/{id}/${action}`, `${action}CollaborationReview`, 'CollaborationReviewDecision', 'CollaborationReview');
collaborationOperation('post', '/api/assignments/{id}/handoffs', 'createResponsibilityHandoff', 'CollaborationHandoffRequest', 'CollaborationHandoff');
collaborationOperation('get', '/api/work-items/{id}/handoffs', 'listResponsibilityHandoffs', null, 'CollaborationHandoff', true);
for (const action of ['accept', 'decline']) collaborationOperation('post', `/api/handoffs/{id}/${action}`, `${action}ResponsibilityHandoff`, 'CollaborationVersionRequest', 'CollaborationHandoff');
collaborationOperation('get', '/api/me/inbox', 'getCollaborationInbox', null, 'CollaborationInboxListItem', true, [
  { name: 'projectId', in: 'query', required: true, schema: id },
  { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['pending', 'read', 'resolved', 'dismissed'], default: 'pending' } }, ...pageParameters,
]);
for (const action of ['read', 'resolve', 'dismiss']) collaborationOperation('post', `/api/inbox/{id}/${action}`, `${action}CollaborationInbox`, 'CollaborationVersionRequest', 'CollaborationInbox');
for (const path of ['/api/work-items/{workItemId}/assignments', '/api/review-requests', '/api/assignments/{id}/handoffs']) {
  paths[path].post.parameters.push({ $ref: '#/components/parameters/IdempotencyKey' });
  paths[path].post['x-idempotency-required'] = true;
}

const api = {
  openapi: '3.1.0', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: { title: 'Titan Control Plane', version: '1.2.0', description: 'HTTP/JSON + SSE 契约，包含本机执行及有界云端Handoff控制面。Snapshot实际导出、Secret解析及容器执行由宿主Daemon负责，不提供原生模型进程热迁移。认证覆盖以各操作security为准。' },
  servers: [{ url: 'http://127.0.0.1:3000', description: '本机默认端口；CONTROL_PLANE_PORT 可覆盖。' }], security: [],
  'x-generation': { source: 'packages/contracts/src/schemas.ts; apps/control-plane/src/modules/**; apps/control-plane/src/common/http-error.filter.ts', template: 'packages/contracts/openapi/generate.mjs', templateVersion: 3, generatedAt: new Date().toISOString() },
  'x-reserved-only': ['ConnectRPC', 'RemoteGitSnapshotTransfer'],
  paths,
  components: {
    securitySchemes: {
      DaemonBearer: { type: 'http', scheme: 'bearer', bearerFormat: '64 lowercase hexadecimal characters', description: 'Authorization: Bearer <authToken>，绑定路径 daemonId；只用于 Daemon API。模型凭证通过 credentialRef 在本机解析。' },
      ConsoleBearer: { type: 'http', scheme: 'bearer', description: 'Authorization: Bearer <TITAN_CONSOLE_TOKEN>；用于控制台、工件正文、Handoff和Cloud管理。由本机服务端环境配置，未设置时拒绝访问；不是模型API Key。' },
      WorkflowBearer: { type: 'http', scheme: 'bearer', description: '独立Workflow服务身份，仅用于/api/internal/workflow；绑定workerId，凭证通过Keychain引用或受控stdin加载至内存，拒绝Console/Daemon凭证复用，未配置时拒绝访问。环境仅允许非Secret的credentialRef与workerId，禁止明文Token。' },
    },
    parameters: {
      IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 1, maxLength: 200 }, description: 'Project/Task/Session/Run 创建及 Run resume 可改用正文 idempotencyKey，请求头优先；trim 后校验长度，不是 Daemon 事件去重键。' },
      ArtifactIdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' }, description: 'Artifact 只读请求头，当前不校验长度；省略时由控制器生成基于 Date.now() 的键，不能作为安全重放保证。' },
      TraceId: { name: 'X-Trace-Id', in: 'header', required: false, schema: { type: 'string' }, description: 'HttpErrorFilter 回传到错误 traceId；当前成功事件并不自动继承该请求头。' },
      LastEventId: { name: 'Last-Event-ID', in: 'header', required: false, schema: { type: 'string', pattern: '^\\d+$', default: '0' }, description: 'Run 内最后已消费的 sequence，非 eventId；须为 0..9007199254740991 且不得超过服务端最新游标。' },
    },
    responses: { Error: { description: '统一错误：400 校验/状态/门禁（含 APPROVAL_REQUIRED、DAEMON_UNAVAILABLE）；401 无效 Daemon 凭证；403 权限；404 不存在；409 幂等、版本、序号、Plan 冲突；500 未归类异常。retryable 由错误码决定，不由状态码决定。', content: json(ref('ApiError')) } },
    schemas,
  },
};

const target = new URL('./control-plane.openapi.json', import.meta.url);
if (process.argv.includes('--check')) {
  const existing = JSON.parse(await readFile(target, 'utf8'));
  api['x-generation'].generatedAt = existing['x-generation'].generatedAt;
  if (JSON.stringify(existing) !== JSON.stringify(api)) throw new Error('OpenAPI artifact is stale; build contracts and rerun openapi/generate.mjs');
  console.log('OpenAPI artifact matches the current schema and generator.');
} else {
  await writeFile(target, `${JSON.stringify(api, null, 2)}\n`, 'utf8');
  console.log('Generated packages/contracts/openapi/control-plane.openapi.json');
}
