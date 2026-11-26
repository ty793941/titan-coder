<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  Play,
  Pause,
  Square,
  RotateCcw,
  ChevronDown,
  AlertCircle,
  Cpu,
  ExternalLink,
  Hash,
  ArrowRight as ArrowIcon,
} from "lucide-vue-next";
import { api, errorMessage, newRequestKey } from "../api";
import type {
  Artifact,
  ConsoleState,
  LocalStatus,
  Provider,
  Run,
  Task,
} from "../types";
import { runBlocker, latestArtifact, shortId, formatTime } from "../workflow";
import StatusBadge from "./StatusBadge.vue";
import EmptyState from "./EmptyState.vue";
import RunEvents from "./RunEvents.vue";
const props = defineProps<{
  task: Task;
  artifacts: Artifact[];
  state: ConsoleState;
  local: LocalStatus | null;
  initialRunId?: string;
}>();
const emit = defineEmits<{
  refresh: [];
  notify: [message: string];
  environment: [];
  task: [];
}>();
const runtime = ref<Provider>("qwen");
const model = ref("");
const daemonId = ref("");
const workspace = ref("");
const goal = ref(props.task.goal);
const showForm = ref(false);
const busy = ref(false);
const error = ref("");
const selectedRunId = ref("");
const selectedSessionId = ref("");
const sessions = computed(() =>
  props.state.sessions.filter((item) => item.taskId === props.task.id),
);
const sessionIds = computed(
  () => new Set(sessions.value.map((item) => item.id)),
);
const runs = computed(() =>
  props.state.runs
    .filter((item) => sessionIds.value.has(item.sessionId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
);
const selectedRun = computed(() =>
  runs.value.find((item) => item.id === selectedRunId.value),
);
const selectedSession = computed(() =>
  sessions.value.find((item) => item.id === selectedSessionId.value),
);
const selectedDaemon = computed(() =>
  props.state.daemons.find((item) => item.daemonId === daemonId.value),
);
const credential = computed(() =>
  props.local?.credentials.find((item) => item.provider === runtime.value),
);
const daemonOnline = computed(
  () =>
    !!selectedDaemon.value &&
    !["offline", "disconnected", "revoked"].includes(
      selectedDaemon.value.status,
    ),
);
const blocker = computed(() =>
  runBlocker(
    props.task.stage,
    props.artifacts,
    daemonOnline.value,
    !!credential.value?.configured && (runtime.value !== "codex" || !!credential.value?.baseUrlConfigured),
  ),
);
const selectedSessionCredential = computed(() =>
  props.local?.credentials.find(
    (item) => item.provider === selectedSession.value?.execution?.runtime,
  ),
);
const selectedSessionDaemon = computed(() =>
  props.state.daemons.find(
    (item) => item.daemonId === selectedSession.value?.execution?.daemonId,
  ),
);
const existingBlocker = computed(() => {
  if (!selectedSession.value?.execution)
    return "请选择已配置执行环境的 Session，或创建新的 Session。";
  if (
    selectedSession.value.planHash !==
    latestArtifact(props.artifacts, "plan")?.checksum
  )
    return "此 Session 的计划已过期，请创建新的 Session。";
  if (
    selectedSession.value.execution.credentialRef &&
    selectedSession.value.execution.credentialRef !==
    selectedSessionCredential.value?.credentialRef
  )
    return "此 Session 使用了其他凭证引用，请创建使用当前本机 Key 的新 Session。";
  if (selectedSession.value.execution.runtime === "codex" && !selectedSession.value.execution.baseUrlRef)
    return "此 Session 没有绑定 Codex API URL，请创建新的 Session。";
  const daemon = selectedSessionDaemon.value;
  return runBlocker(
    props.task.stage,
    props.artifacts,
    !!daemon && !["offline", "disconnected", "revoked"].includes(daemon.status),
    !!selectedSessionCredential.value?.configured && (selectedSession.value.execution.runtime !== "codex" || !!selectedSessionCredential.value?.baseUrlConfigured),
  );
});
watch(
  () => props.task.id,
  () => {
    goal.value = props.task.goal;
    error.value = "";
    showForm.value = false;
  },
);
watch(
  () => props.local?.workspaceRoot,
  (value) => {
    if (!workspace.value && value) workspace.value = value;
  },
  { immediate: true },
);
watch(
  () => props.state.daemons,
  (daemons) => {
    if (!daemons.some((item) => item.daemonId === daemonId.value))
      daemonId.value =
        daemons.find((item) => item.daemonId === props.local?.daemon.daemonId)
          ?.daemonId ||
        daemons[0]?.daemonId ||
        "";
  },
  { immediate: true },
);
watch(
  sessions,
  (values) => {
    if (!values.some((item) => item.id === selectedSessionId.value))
      selectedSessionId.value = values.at(-1)?.id || "";
  },
  { immediate: true },
);
watch(
  runs,
  (values) => {
    if (!values.some((item) => item.id === selectedRunId.value))
      selectedRunId.value = values[0]?.id || "";
  },
  { immediate: true },
);
watch(
  () => props.initialRunId,
  (value) => {
    if (value && runs.value.some((run) => run.id === value)) selectedRunId.value = value;
  },
  { immediate: true },
);
async function createSession() {
  const plan = latestArtifact(props.artifacts, "plan");
  if (
    !plan ||
    blocker.value ||
    busy.value ||
    !workspace.value.trim() ||
    !goal.value.trim()
  )
    return;
  busy.value = true;
  error.value = "";
  try {
    const session = await api.createSession(props.task.id, {
      entryAgent: "project-manager",
      goal: goal.value.trim(),
      planHash: plan.checksum,
      idempotencyKey: newRequestKey(),
      execution: {
        daemonId: daemonId.value,
        runtime: runtime.value,
        credentialRef: credential.value!.credentialRef,
        ...(runtime.value === "codex" && credential.value?.baseUrlRef ? { baseUrlRef: credential.value.baseUrlRef } : {}),
        ...(model.value.trim() ? { modelRef: model.value.trim() } : {}),
        workspacePath: workspace.value.trim(),
        allowedTools: [
          "artifact.write",
          "workspace.read",
          "workspace.search",
          "workspace.write",
        ],
        maxTurns: 6,
        timeoutMs: 120000,
      },
    });
    selectedSessionId.value = session.id;
    showForm.value = false;
    emit("refresh");
    emit("notify", "Session 已创建。确认配置后，点击开始运行。");
  } catch (caught) {
    error.value = errorMessage(caught);
    emit("refresh");
  } finally {
    busy.value = false;
  }
}
async function createRun() {
  if (!selectedSession.value || existingBlocker.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const run = await api.createRun(selectedSession.value.id);
    selectedRunId.value = run.id;
    emit("refresh");
    emit("notify", "运行已提交至队列，等待 Daemon 认领。");
  } catch (caught) {
    error.value = errorMessage(caught);
    emit("refresh");
  } finally {
    busy.value = false;
  }
}
async function control(run: Run, action: "pause" | "resume" | "cancel") {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await api.controlRun(run.id, action);
    if (action === "resume") selectedRunId.value = result.id;
    emit("refresh");
    emit(
      "notify",
      action === "resume"
        ? "恢复请求已提交，将创建新的运行尝试。"
        : action === "pause"
          ? "已发送暂停请求。"
          : "已发送取消请求。",
    );
  } catch (caught) {
    error.value = errorMessage(caught);
    emit("refresh");
  } finally {
    busy.value = false;
  }
}
const activeStatuses = [
  "queued",
  "starting",
  "running",
  "reconnecting",
  "waiting_input",
];
</script>

<template>
  <section class="view-intro">
    <div>
      <div class="eyebrow">CONTROLLED EXECUTION</div>
      <h2>让计划真正运行<span class="accent">.</span></h2>
      <p>{{ task.title }} · 运行、事件与恢复记录都在这里。</p>
    </div>
    <button class="button" @click="showForm = !showForm">
      {{ showForm ? "收起配置" : "新建 Session"
      }}<ChevronDown :size="15" :class="{ rotated: showForm }" />
    </button>
  </section>
  <section v-if="showForm || !sessions.length" class="panel session-form-panel">
    <div class="panel-heading">
      <div class="heading-with-icon">
        <Cpu :size="19" />
        <div>
          <h3>执行配置</h3>
          <p>创建独立 Session，随后由你手动开始运行。</p>
        </div>
      </div>
      <span class="eyebrow">LOCAL ONLY</span>
    </div>
    <form class="session-form" @submit.prevent="createSession">
      <div class="form-grid">
        <div>
          <label for="runtime">模型提供方</label
          ><select
            id="runtime"
            v-model="runtime"
            :disabled="busy"
            @change="model = ''"
          >
            <option value="qwen">Qwen · 官方 API</option>
            <option value="codex">Codex · App Server</option>
          </select>
        </div>
        <div>
          <label for="model">模型名称 <span class="muted">可选</span></label
          ><input
            id="model"
            v-model="model"
            maxlength="200"
            :disabled="busy"
            :placeholder="
              runtime === 'qwen'
                ? '例如 qwen-plus；留空使用 Adapter 默认值'
                : '填写账户可用模型；留空使用 Codex 默认值'
            "
          />
        </div>
        <div>
          <label for="daemon">执行设备</label
          ><select id="daemon" v-model="daemonId" required :disabled="busy">
            <option v-if="!state.daemons.length" value="">
              暂无设备，请先启动本机 Daemon
            </option>
            <option
              v-for="daemon in state.daemons"
              :key="daemon.daemonId"
              :value="daemon.daemonId"
            >
              {{ daemon.machineName }} · {{ daemon.status }}
            </option>
          </select>
        </div>
        <div>
          <label for="workspace"
            >授权工作区 <span class="muted">绝对路径</span></label
          ><input
            id="workspace"
            v-model="workspace"
            required
            maxlength="4096"
            :disabled="busy"
            placeholder="/path/to/workspace"
          />
        </div>
      </div>
      <label for="session-goal">本次执行目标</label
      ><textarea
        id="session-goal"
        v-model="goal"
        required
        maxlength="2000"
        rows="3"
        :disabled="busy"
      />
      <div class="session-limits">
        <span>最大 6 轮</span><span>超时 120 秒</span
        ><span>文件读写 + 工件输出</span>
      </div>
      <p v-if="selectedDaemon" class="field-help">
        设备授权根目录：<code>{{
          selectedDaemon.workspaceRoots.join(" · ")
        }}</code>
      </p>
      <div v-if="blocker" class="notice warning">
        <AlertCircle :size="17" />
        <p>
          {{ blocker }}
          <button
            type="button"
            class="text-link"
            @click="
              task.stage !== 'implement' ? emit('task') : emit('environment')
            "
          >
            {{ task.stage !== "implement" ? "前往任务审批" : "查看环境配置"
            }}<ExternalLink :size="12" />
          </button>
        </p>
      </div>
      <div class="form-footer">
        <span class="helper-text">只传递凭证引用，不传递 Key。</span
        ><button
          type="submit"
          class="button primary"
          :disabled="busy || !!blocker || !workspace.trim() || !goal.trim()"
        >
          {{ busy ? "创建中…" : "创建 Session" }}<ArrowIcon />
        </button>
      </div>
    </form>
  </section>
  <section v-if="sessions.length" class="panel launch-panel">
    <div>
      <label for="existing-session">选择 Session</label
      ><select
        id="existing-session"
        v-model="selectedSessionId"
        :disabled="busy"
      >
        <option
          v-for="session in sessions"
          :key="session.id"
          :value="session.id"
        >
          {{ shortId(session.id) }} ·
          {{ session.execution?.runtime || "未配置执行环境" }}
        </option>
      </select>
      <p v-if="selectedSession?.execution" class="field-help">
        {{ selectedSession.execution.runtime }} ·
        {{ selectedSession.execution.modelRef || "Adapter 默认模型" }} ·
        <code>{{ selectedSession.execution.workspacePath }}</code>
      </p>
    </div>
    <div class="launch-action">
      <button
        class="button primary"
        :disabled="busy || !!existingBlocker"
        @click="createRun"
      >
        <Play :size="15" />{{ busy ? "处理中…" : "开始真实运行" }}</button
      ><span class="field-help">将调用模型 API，可能产生费用。</span>
    </div>
    <p v-if="existingBlocker" class="launch-warning">{{ existingBlocker }}</p>
  </section>
  <p v-if="error" role="alert" class="notice error">{{ error }}</p>
  <section class="panel runs-panel">
    <div class="panel-heading">
      <h3>运行记录</h3>
      <span class="count-label">{{ runs.length }} 次尝试</span>
    </div>
    <EmptyState
      v-if="!runs.length"
      compact
      title="尚无运行记录"
      description="完成计划审批和环境配置后，创建 Session 并开始真实运行。"
    />
    <div v-else class="table-scroll">
      <table class="run-table">
        <thead>
          <tr>
            <th>Run / 尝试</th>
            <th>状态</th>
            <th>创建时间</th>
            <th class="align-right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="run in runs"
            :key="run.id"
            :class="{ selected: selectedRunId === run.id }"
          >
            <td>
              <button
                class="run-id-link"
                :title="run.id"
                @click="selectedRunId = run.id"
              >
                <Hash :size="12" />{{ shortId(run.id) }}</button
              ><span class="attempt-label"
                >ATTEMPT {{ String(run.attempt).padStart(2, "0") }}</span
              >
            </td>
            <td>
              <StatusBadge :status="run.status" /><span
                v-if="run.errorCode"
                class="run-error-code"
                >{{ run.errorCode }}</span
              >
            </td>
            <td class="mono date-cell">{{ formatTime(run.createdAt) }}</td>
            <td>
              <div class="row-actions">
                <button
                  v-if="
                    ['queued', 'starting', 'running', 'reconnecting'].includes(
                      run.status,
                    )
                  "
                  class="icon-button"
                  aria-label="暂停此运行"
                  title="暂停"
                  :disabled="busy"
                  @click="control(run, 'pause')"
                >
                  <Pause :size="15" /></button
                ><button
                  v-if="run.status === 'paused'"
                  class="button small"
                  :disabled="busy"
                  @click="control(run, 'resume')"
                >
                  <RotateCcw :size="13" />恢复</button
                ><button
                  v-if="
                    activeStatuses.includes(run.status) ||
                    run.status === 'paused'
                  "
                  class="icon-button danger-quiet"
                  aria-label="取消此运行"
                  title="取消"
                  :disabled="busy"
                  @click="control(run, 'cancel')"
                >
                  <Square :size="14" /></button
                ><button class="button small" @click="selectedRunId = run.id">
                  事件
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <div v-if="selectedRun" class="selected-run-caption">
    <code>{{ selectedRun.id }}</code
    ><span v-if="selectedRun.checkpointId"
      >Checkpoint <code>{{ shortId(selectedRun.checkpointId) }}</code></span
    >
  </div>
  <RunEvents
    v-if="selectedRun"
    :run-id="selectedRun.id"
    :status="selectedRun.status"
  />
</template>
