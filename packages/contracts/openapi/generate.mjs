import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import * as source from '../dist/schemas.js';
import { errorCodes } from '../dist/errors.js';

// 仅用于离线协议工件生成，不注册运行时路由；新增 Zod 类型必须显式支持。
function jsonSchema(schema) {
  const def = schema._def;
  switch (def.typeName) {
    case 'ZodOptional': return jsonSchema(def.innerType);
    case 'ZodDefault': return { ...jsonSchema(def.innerType), default: def.defaultValue() };
    case 'ZodEffects': return jsonSchema(def.schema);
    case 'ZodUnknown': return {};
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodLiteral': return { type: typeof def.value, const: def.value };
    case 'ZodEnum': return { type: 'string', enum: def.values };
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
  ProgressOutput: source.progressOutputSchema,
  ArtifactWriteOutput: source.artifactWriteOutputSchema,
  DaemonRegistration: source.daemonRegistrationSchema,
  DaemonEventRequest: source.daemonEventSchema,
  Artifact: source.artifactSchema,
  EventEnvelope: source.eventEnvelopeSchema,
}).map(([key, value]) => [key, jsonSchema(value)]));

schemas.SessionCreateRequest.properties.execution = ref('ExecutionConfig');
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
schemas.EventEnvelope.required.push('payload');
schemas.EventEnvelope.properties.actor = ref('Actor');
schemas.EventEnvelope.properties.sequence.maximum = Number.MAX_SAFE_INTEGER;

Object.assign(schemas, {
  Actor: object({ type: { type: 'string', enum: ['user', 'agent', 'daemon', 'system'] }, id }),
  ExecutionStatus: jsonSchema(source.executionStatusSchema),
  Project: object({ id, name: text, goal: text, createdAt: date, version: positive }),
  Task: object({ id, projectId: id, title: text, goal: text, acceptanceCriteria: array(text), priority: jsonSchema(source.prioritySchema),
    stage: jsonSchema(source.taskStageSchema), status: { type: 'string', enum: ['active', 'blocked', 'paused', 'cancelled', 'failed', 'completed'] }, version: positive, createdAt: date }),
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
    security: options.auth === 'console' ? [{ ConsoleBearer: [] }] : options.auth ? [{ DaemonBearer: [] }] : [], parameters,
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
operation('get', '/api/tasks/{taskId}', 'getTask', '查询 Task', { responses: { '200': response('Task 业务事实。', ref('Task')) } });
operation('get', '/api/tasks/{taskId}/events', 'listTaskEvents', '查询 Task 关联事件', { description: '返回 JSON 数组，按 occurredAt 升序；可能包含多个 Run 各自的序号，不能当成单一 SSE 游标。未知 Task 当前返回空数组。', responses: { '200': response('关联事件数组。', array(ref('EventEnvelope'))) } });
operation('post', '/api/tasks/{taskId}/stage', 'advanceTaskStage', '推进相邻 QRSPI 阶段', { body: 'StageRequest', responses: { '200': response('更新后的 Task，version 加一。', ref('Task')) } });
create('/api/tasks/{taskId}/sessions', 'Session', 'SessionCreateRequest', 'Session', '创建项目经理 Session；execution 可省略，提供时要求最新已批准 planHash、本机可用 Daemon 和 workspace 授权。');
operation('get', '/api/sessions/{sessionId}', 'getSession', '查询 Session', { responses: { '200': response('不包含 execution 配置、goal 或内部 version。', ref('Session')) } });
create('/api/sessions/{sessionId}/runs', 'Run', 'RunCreateRequest', 'Run', '创建新的 Run attempt；恢复使用同一 Session 的 checkpointId，旧 Run 保留。');
operation('get', '/api/runs/{runId}', 'getRun', '查询 Run', { responses: { '200': response('Run 当前状态。', ref('Run')) } });
operation('post', '/api/runs/{runId}/pause', 'pauseRun', '暂停 Run 并请求停止执行', {
  description: '同步将非终态 Run/Session 标记 paused，已有 execution_job 标记 paused 与 cancelRequested=true，保留持久检查点并产生 run.paused 事件。重复暂停返回同一 Run；completed/failed/cancelled 返回 400 INVALID_STATE_TRANSITION。Daemon 通过 control 轮询停止进程，200 不证明进程已经退出；不是原生模型会话热暂停。',
  responses: { '200': response('原 Run 的 paused 业务视图，不创建新 attempt。', ref('Run')) },
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
paths['/api/daemons/{id}/handoffs/{handoffId}/snapshot'].post.description += ' 创建目标前锁定源Session，要求sourceRun为attempt最大的最新Run且该Session没有queued/starting/running/waiting_input/reconnecting Run；旧Run再次paused不能绕过此校验，失败返回400 HANDOFF_CHECKPOINT_INVALID。manifest.snapshotId为小写UUID，fileCount最多10000、totalBytes最多33554432，baseRevision为40或64位小写十六进制、checksum仅允许sha256:加64位小写十六进制。';
paths['/api/daemons/{daemonId}/runs/{runId}/progress'].post.description += ' cloud工件URI必须已由宿主映射为唯一登记workspaceRoot/sessionId/session/.titan/artifacts/UUID/logicalPath，严格绑定cloud_execution、Session和Daemon；拒绝虚拟容器URI、其他Session路径和多root歧义。checkpoint及结构化tool output均校验，保留artifact://引用与checksum。';
paths['/api/artifacts/{artifactId}/content'].get.description += ' cloud工件仅允许创建来源为所属Daemon、关联真实cloud_execution的记录；宿主根从该Daemon唯一workspaceRoot推导到sessionId/session，读取时校验realpath仍为该根下精确Session目录，拒绝Session目录及工件目录符号链接逃逸。宿主文件需由Executor在容器退出后保留，CP不调用Docker。';

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
