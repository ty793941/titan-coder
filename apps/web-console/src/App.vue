<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import {
  ArrowUpRight,
  ArrowRight,
  Blocks,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  FileStack,
  FolderPlus,
  LayoutList,
  ListPlus,
  Menu,
  PanelLeftClose,
  Radio,
  RefreshCw,
  Settings2,
  Terminal,
  X,
  Activity,
} from "lucide-vue-next";
import { useConsole } from "./useConsole";
import { formatTime, shortId, stageLabel } from "./workflow";
import TaskWorkspace from "./components/TaskWorkspace.vue";
import RunWorkspace from "./components/RunWorkspace.vue";
import ArtifactExplorer from "./components/ArtifactExplorer.vue";
import EnvironmentPanel from "./components/EnvironmentPanel.vue";
import EmptyState from "./components/EmptyState.vue";
import CreateDialog from "./components/CreateDialog.vue";
const {
  state,
  local,
  projectId,
  taskId,
  project,
  tasks,
  task,
  artifacts,
  loading,
  refreshing,
  stateError,
  localError,
  artifactsError,
  artifactsLoading,
  lastSync,
  refresh,
} = useConsole();
type View = "tasks" | "runs" | "artifacts" | "environment";
const view = ref<View>("tasks");
const nav = [
  {
    id: "tasks" as const,
    title: "任务工作台",
    english: "WORKSPACE",
    icon: LayoutList,
  },
  {
    id: "runs" as const,
    title: "运行与事件",
    english: "EXECUTIONS",
    icon: Terminal,
  },
  {
    id: "artifacts" as const,
    title: "工件与证据",
    english: "ARTIFACTS",
    icon: FileStack,
  },
  {
    id: "environment" as const,
    title: "环境与 Key",
    english: "ENVIRONMENT",
    icon: Settings2,
  },
];
const page = computed(() => nav.find((item) => item.id === view.value)!);
const sidebarOpen = ref(false);
const dialog = ref<"project" | "task" | null>(null);
const search = ref("");
const visibleTasks = computed(() =>
  tasks.value.filter((item) =>
    `${item.title} ${item.id}`
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
);
const activeRuns = computed(
  () =>
    state.value.runs.filter((item) =>
      ["queued", "starting", "running", "reconnecting"].includes(item.status),
    ).length,
);
const keyCount = computed(
  () => local.value?.credentials.filter((item) => item.configured).length || 0,
);
const notification = ref("");
let notificationTimer: ReturnType<typeof setTimeout> | undefined;
function notify(message: string) {
  notification.value = message;
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => {
    notification.value = "";
  }, 6500);
}
function navigate(target: View) {
  view.value = target;
  sidebarOpen.value = false;
}
async function created(id: string, kind: "project" | "task") {
  dialog.value = null;
  await refresh();
  if (kind === "project") projectId.value = id;
  else taskId.value = id;
  view.value = "tasks";
  notify(
    kind === "project"
      ? "项目已创建。现在可以定义第一个任务。"
      : "任务已创建，从问题确认开始。",
  );
}
onBeforeUnmount(() => clearTimeout(notificationTimer));
</script>

<template>
  <a class="skip-link" href="#main-content">跳至主要内容</a>
  <div class="app-shell">
    <div
      v-if="sidebarOpen"
      class="sidebar-scrim"
      @click="sidebarOpen = false"
    />
    <aside class="sidebar" :class="{ open: sidebarOpen }" aria-label="主导航">
      <a class="brand" href="#" @click.prevent="navigate('tasks')"
        ><span class="brand-symbol"
          ><Blocks :size="26" :stroke-width="1.6" /></span
        ><span class="brand-word">titan<span class="brand-dot">.</span></span
        ><span class="local-tag">LOCAL</span></a
      >
      <div class="sidebar-workspace">
        <span class="sidebar-eyebrow">你的工作空间</span>
        <div class="workspace-identity">
          <span class="workspace-avatar">T</span>
          <div><strong>本机验收</strong><span>Phase 01 / Console</span></div>
          <span class="small-dot green" />
        </div>
      </div>
      <nav>
        <button
          v-for="item in nav"
          :key="item.id"
          :class="['nav-item', { active: view === item.id }]"
          :aria-current="view === item.id ? 'page' : undefined"
          @click="navigate(item.id)"
        >
          <component :is="item.icon" :size="18" :stroke-width="1.6" /><span>{{
            item.title
          }}</span
          ><span v-if="item.id === 'runs' && activeRuns" class="nav-count">{{
            activeRuns
          }}</span
          ><span
            v-else-if="item.id === 'environment' && keyCount < 2"
            class="nav-indicator"
          /><ChevronRight
            v-else-if="view === item.id"
            :size="14"
            class="nav-chevron"
          />
        </button>
      </nav>
      <div class="sidebar-guide">
        <div class="guide-icon"><Command :size="19" /></div>
        <span class="sidebar-eyebrow">从想法，到可验收产物</span>
        <p>计划由你批准，执行留有证据。</p>
        <button @click="navigate('environment')">
          准备执行环境<ArrowUpRight :size="14" />
        </button>
      </div>
      <div class="sidebar-footer">
        <span class="sidebar-eyebrow">LOCAL EXECUTION ENGINE</span>
        <div>
          <span
            class="small-dot"
            :class="{ green: local?.daemon.running }"
          /><span>{{
            local?.daemon.running ? "Daemon 正在运行" : "Daemon 尚未启动"
          }}</span
          ><Activity :size="15" />
        </div>
        <span class="mono">TITAN / PHASE 1</span>
      </div>
      <button
        class="sidebar-close icon-button"
        aria-label="收起导航"
        @click="sidebarOpen = false"
      >
        <PanelLeftClose :size="18" />
      </button>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <div class="breadcrumbs">
          <button
            class="icon-button mobile-menu"
            aria-label="打开主导航"
            :aria-expanded="sidebarOpen"
            @click="sidebarOpen = !sidebarOpen"
          >
            <Menu :size="21" /></button
          ><span class="muted">本机验收</span
          ><ChevronRight :size="13" /><strong>{{ page.title }}</strong>
        </div>
        <div class="topbar-right">
          <span
            class="connection-pill"
            :class="{ disconnected: stateError || loading }"
            ><span
              class="small-dot"
              :class="{ green: !stateError && !loading }"
            />{{
              loading ? "连接中" : stateError ? "连接异常" : "控制面已连接"
            }}</span
          ><span class="topbar-divider" /><button
            class="icon-button refresh-button"
            :disabled="refreshing"
            aria-label="刷新全部状态"
            @click="refresh"
          >
            <RefreshCw :size="16" :class="{ spinning: refreshing }" /></button
          ><span class="user-avatar" aria-label="本机用户">L</span>
        </div>
      </header>
      <main id="main-content" tabindex="-1">
        <div class="page-heading">
          <div>
            <div class="eyebrow">
              TITAN CONSOLE <span class="eyebrow-slash">/</span>
              {{ page.english }}
            </div>
            <h1>{{ view === "tasks" ? "本机验收工作台" : page.title }}</h1>
          </div>
          <div class="page-heading-meta">
            <span class="phase-label">PHASE 01</span
            ><span class="mono">{{
              lastSync ? `同步于 ${formatTime(lastSync)}` : "等待首次同步"
            }}</span>
          </div>
        </div>
        <div v-if="stateError" role="alert" class="notice error">
          <Radio :size="19" />
          <div>
            <strong>控制面连接异常</strong>
            <p>
              {{ stateError
              }}{{ lastSync ? " 当前显示上次成功同步的数据。" : "" }}
            </p>
          </div>
          <button class="button small" :disabled="refreshing" @click="refresh">
            重试
          </button>
        </div>
        <template v-if="view === 'environment'"
          ><EnvironmentPanel
            :status="local"
            :daemons="state.daemons"
            :error="localError"
            @refresh="refresh"
            @notify="notify"
        /></template>
        <template v-else>
          <section class="project-bar">
            <div class="project-selector">
              <span class="project-glyph"><Command :size="17" /></span>
              <div>
                <label for="project-select">当前项目</label>
                <div class="select-wrap">
                  <select
                    id="project-select"
                    v-model="projectId"
                    :disabled="!state.projects.length"
                  >
                    <option v-if="!state.projects.length" value="">
                      尚无项目
                    </option>
                    <option
                      v-for="item in state.projects"
                      :key="item.id"
                      :value="item.id"
                    >
                      {{ item.name }}
                    </option></select
                  ><ChevronDown :size="13" />
                </div>
              </div>
            </div>
            <p v-if="project" class="project-goal">{{ project.goal }}</p>
            <button
              class="button small"
              :disabled="loading || !!stateError"
              @click="dialog = 'project'"
            >
              <FolderPlus :size="14" />新建项目
            </button>
          </section>
          <div v-if="loading" class="loading-workspace" role="status">
            <span class="loading-line" /><span class="eyebrow"
              >正在同步本机工作空间</span
            >
            <p>读取项目、任务与运行状态…</p>
          </div>
          <EmptyState
            v-else-if="!project"
            class="panel welcome-empty"
            title="从第一个验收项目开始"
            description="创建项目、定义任务、逐步审批计划，然后让模型在本机执行。"
            ><button
              class="button primary"
              :disabled="!!stateError"
              @click="dialog = 'project'"
            >
              <FolderPlus :size="16" />创建项目<ArrowRight :size="15" /></button
            ><button class="text-link" @click="navigate('environment')">
              先配置模型 Key<ArrowUpRight :size="14" /></button
          ></EmptyState>
          <template v-else>
            <div v-if="view === 'tasks'" class="workspace-layout">
              <section class="panel task-list-panel">
                <div class="task-list-heading">
                  <div>
                    <h3>
                      项目任务<span class="task-count">{{ tasks.length }}</span>
                    </h3>
                    <span class="eyebrow">ACCEPTANCE QUEUE</span>
                  </div>
                  <button
                    class="icon-button"
                    aria-label="新建任务"
                    :disabled="!!stateError"
                    @click="dialog = 'task'"
                  >
                    <ListPlus :size="19" />
                  </button>
                </div>
                <div class="task-search">
                  <label for="task-search" class="sr-only">搜索任务</label
                  ><input
                    id="task-search"
                    v-model="search"
                    type="search"
                    placeholder="搜索任务名称或 ID…"
                  />
                </div>
                <div class="task-list">
                  <button
                    v-for="item in visibleTasks"
                    :key="item.id"
                    :class="['task-item', { selected: taskId === item.id }]"
                    @click="taskId = item.id"
                  >
                    <div class="task-item-meta">
                      <span
                        class="priority-dot"
                        :data-priority="item.priority"
                      /><span class="mono">{{ shortId(item.id) }}</span
                      ><ChevronRight v-if="taskId === item.id" :size="12" />
                    </div>
                    <strong>{{ item.title }}</strong>
                    <div class="task-item-footer">
                      <span>{{ stageLabel(item.stage) }}</span
                      ><span class="task-item-version"
                        >v{{ item.version }}</span
                      >
                    </div>
                  </button>
                  <div v-if="!visibleTasks.length" class="task-list-empty">
                    <p>{{ search ? "没有匹配的任务" : "等待第一个任务" }}</p>
                    <button
                      v-if="!search"
                      class="text-link"
                      @click="dialog = 'task'"
                    >
                      定义任务<ArrowRight :size="13" />
                    </button>
                  </div>
                </div>
                <button
                  class="task-list-add"
                  :disabled="!!stateError"
                  @click="dialog = 'task'"
                >
                  <ListPlus :size="15" />新建验收任务
                </button>
              </section>
              <div class="workspace-detail">
                <TaskWorkspace
                  v-if="task"
                  :key="task.id"
                  :task="task"
                  :artifacts="artifacts"
                  :artifacts-error="artifactsError"
                  @refresh="refresh"
                  @notify="notify"
                  @run="navigate('runs')"
                /><EmptyState
                  v-else
                  class="panel"
                  title="把目标拆成一个可验收任务"
                  description="写清目标和标准，工作台会引导你完成六阶段准备。"
                  ><button class="button primary" @click="dialog = 'task'">
                    <ListPlus :size="16" />新建任务
                  </button></EmptyState
                >
              </div>
            </div>
            <template v-else
              ><div class="task-context">
                <label for="context-task">当前任务</label
                ><select
                  id="context-task"
                  v-model="taskId"
                  :disabled="!tasks.length"
                >
                  <option v-if="!tasks.length" value="">尚无任务</option>
                  <option v-for="item in tasks" :key="item.id" :value="item.id">
                    {{ item.title }}
                  </option></select
                ><button class="text-link" @click="navigate('tasks')">
                  查看任务<ArrowUpRight :size="13" />
                </button>
              </div>
              <EmptyState
                v-if="!task"
                class="panel"
                title="请先创建一个任务"
                description="运行与工件都属于具体任务。创建任务后即可在这里查看。"
                ><button class="button primary" @click="navigate('tasks')">
                  进入任务工作台<ArrowRight :size="15" /></button></EmptyState
              ><template v-else
                ><p v-if="artifactsLoading" class="field-help" role="status">
                  正在同步任务工件…
                </p>
                <RunWorkspace
                  v-if="view === 'runs'"
                  :key="task.id"
                  :task="task"
                  :artifacts="artifacts"
                  :state="state"
                  :local="local"
                  @refresh="refresh"
                  @notify="notify"
                  @environment="navigate('environment')"
                  @task="navigate('tasks')" /><ArtifactExplorer
                  v-else
                  :key="task.id"
                  :artifacts="artifacts"
                  :error="artifactsError" /></template
            ></template>
          </template>
        </template>
        <footer class="page-footer">
          <span
            ><span class="footer-mark" />TITAN
            <span class="muted">/</span> 本机验收控制台</span
          ><span
            ><CircleHelp :size="13" />阶段批准后才能执行 · 以真实证据验收</span
          >
        </footer>
      </main>
    </div>
    <CreateDialog
      v-if="dialog"
      :kind="dialog"
      :project-id="projectId"
      @close="dialog = null"
      @created="created"
    />
    <Transition name="toast"
      ><div v-if="notification" class="toast-notification" role="status">
        <span><Check :size="16" /></span>
        <p>{{ notification }}</p>
        <button
          class="icon-button"
          aria-label="关闭通知"
          @click="notification = ''"
        >
          <X :size="15" />
        </button></div
    ></Transition>
  </div>
</template>
