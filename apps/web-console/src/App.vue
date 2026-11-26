<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { ArrowRight } from "lucide-vue-next";
import AcceptanceConsole from "./components/AcceptanceConsole.vue";
import DecisionInbox from "./components/product/DecisionInbox.vue";
import DecisionDetail from "./components/product/DecisionDetail.vue";
import ProjectSpace from "./components/product/ProjectSpace.vue";
import DeliveryView from "./components/product/DeliveryView.vue";
import ActivityView from "./components/product/ActivityView.vue";
import ProductShell from "./components/product/ProductShell.vue";
import GoalDialog from "./components/product/GoalDialog.vue";
import TaskWorkspace from "./components/TaskWorkspace.vue";
import RunWorkspace from "./components/RunWorkspace.vue";
import EnvironmentPanel from "./components/EnvironmentPanel.vue";
import {
  parseProductRoute,
  productRoute,
  type ProductRoute,
} from "./product/routes";
import { useProductData } from "./product/useProductData";
import type { Artifact } from "./types";

const route = ref<ProductRoute>(parseProductRoute(window.location.hash));
const product = useProductData();
const creating = ref<null | { projectId?: string }>(null);
const notice = ref("");
const managerOpen = ref(false);
const selectedTask = computed(() => {
  const target = route.value;
  return target.name === "task"
    ? product.state.value.tasks.find((task) => task.id === target.taskId)
    : undefined;
});
const executionRun = computed(() => {
  const target = route.value;
  return target.name === "execution"
    ? product.state.value.runs.find((run) => run.id === target.runId)
    : undefined;
});
const executionSession = computed(() =>
  product.state.value.sessions.find(
    (session) => session.id === executionRun.value?.sessionId,
  ),
);
const executionTask = computed(() =>
  product.state.value.tasks.find(
    (task) => task.id === executionSession.value?.taskId,
  ),
);
const launchTask = computed(() => {
  const target = route.value;
  return target.name === "launch"
    ? product.state.value.tasks.find((task) => task.id === target.taskId)
    : undefined;
});

function updateRoute() {
  route.value = parseProductRoute(window.location.hash);
  managerOpen.value = false;
  void nextTick(() => document.getElementById("product-content")?.focus());
}

function navigate(next: ProductRoute) {
  window.location.hash = productRoute(next);
}
function openExecution(runId: string) {
  navigate({ name: "execution", runId });
}
async function created(id: string) {
  const taskCreation = !!creating.value?.projectId;
  creating.value = null;
  await product.refresh();
  notice.value = taskCreation
    ? "工作目标已建立。先整理问题与验收标准。"
    : "项目已创建，下一步是定义工作目标。";
  navigate(
    taskCreation
      ? { name: "task", taskId: id }
      : { name: "project", projectId: id },
  );
}

const allArtifacts = () =>
  [...product.artifactsByTask.value.entries()].flatMap(([taskId, artifacts]) =>
    artifacts.map((artifact) => ({
      ...artifact,
      taskId,
      projectId: product.state.value.tasks.find((task) => task.id === taskId)
        ?.projectId,
    })),
  );
const selectedDecision = () =>
  product.decisions.value.find(
    (item) =>
      route.value.name === "decision" && item.id === route.value.decisionId,
  );
const selectedProject = () =>
  product.projects.value.find(
    (item) =>
      route.value.name === "project" && item.id === route.value.projectId,
  );
const projectTasks = (projectId: string) =>
  product.state.value.tasks.filter((task) => task.projectId === projectId);
const projectDecisions = (projectId: string) =>
  product.decisions.value.filter((item) => item.projectId === projectId);
const projectArtifacts = (
  projectId: string,
): Array<Artifact & { projectId: string }> => {
  const taskIds = new Set(projectTasks(projectId).map((task) => task.id));
  return allArtifacts()
    .filter((artifact) => taskIds.has(artifact.taskId))
    .map((artifact) => ({ ...artifact, projectId }));
};
const projectRuns = (projectId: string) => {
  const sessionIds = new Set(
    product.state.value.sessions
      .filter(
        (session) =>
          session.taskId &&
          projectTasks(projectId).some((task) => task.id === session.taskId),
      )
      .map((session) => session.id),
  );
  return product.state.value.runs.filter((run) =>
    sessionIds.has(run.sessionId),
  );
};

window.addEventListener("hashchange", updateRoute);
onBeforeUnmount(() => window.removeEventListener("hashchange", updateRoute));
</script>

<template>
  <AcceptanceConsole
    v-if="route.name === 'acceptance'"
    :initial-run-id="route.runId"
  />
  <ProductShell
    v-else
    :route="route"
    :decisions="product.decisions.value"
    :projects="product.projects.value"
    :loading="product.loading.value"
    :error="product.error.value"
    :partial-errors="product.partialErrors.value"
    :last-sync="product.lastSync.value"
    @navigate="navigate"
    @refresh="product.refresh"
  >
    <DecisionInbox
      v-if="route.name === 'inbox'"
      :decisions="product.decisions.value"
      :projects="product.projects.value"
      :loading="product.loading.value"
      @decision="(id) => navigate({ name: 'decision', decisionId: id })"
      @project="(id) => navigate({ name: 'project', projectId: id })"
      @create="creating = {}"
    />
    <main
      v-else-if="route.name === 'projects'"
      class="product-page product-list-page"
    >
      <header class="product-page-heading">
        <div>
          <span class="product-kicker">PROJECTS / YOUR PORTFOLIO</span>
          <h1>项目<span class="product-period">。</span></h1>
          <p>从目标、风险和交付状态进入每个项目空间。</p>
        </div>
        <button class="product-secondary-action" @click="creating = {}">
          创建项目
        </button>
      </header>
      <section class="product-project-directory">
        <button
          v-for="project in product.projects.value"
          :key="project.id"
          class="product-directory-item"
          @click="navigate({ name: 'project', projectId: project.id })"
        >
          <span
            ><strong>{{ project.name }}</strong
            ><small>{{ project.goal }}</small></span
          ><span class="product-directory-state"
            >查看项目 <ArrowRight :size="14"
          /></span>
        </button>
        <p v-if="!product.projects.value.length" class="product-project-empty">
          还没有项目。请从项目经理开始定义第一个目标。
        </p>
      </section>
    </main>
    <DecisionDetail
      v-else-if="route.name === 'decision' && selectedDecision()"
      :key="selectedDecision()!.id"
      :decision="selectedDecision()!"
      :on-refresh="product.refresh"
      @back="navigate({ name: 'inbox' })"
      @project="(id) => navigate({ name: 'project', projectId: id })"
      @completed="
        () => {
          notice = '决定已记录，项目状态已更新。';
          navigate({ name: 'inbox' });
        }
      "
      @execution="openExecution"
    />
    <template v-else-if="route.name === 'project' && selectedProject()">
      <ProjectSpace
        :project="selectedProject()!"
        :tasks="projectTasks(selectedProject()!.id)"
        :decisions="projectDecisions(selectedProject()!.id)"
        :artifacts="projectArtifacts(selectedProject()!.id)"
        :active-runs="
          projectRuns(selectedProject()!.id).filter((run) =>
            [
              'queued',
              'starting',
              'running',
              'reconnecting',
              'waiting_input',
            ].includes(run.status),
          )
        "
        @decision="(id) => navigate({ name: 'decision', decisionId: id })"
        @deliveries="navigate({ name: 'deliveries' })"
        @activity="navigate({ name: 'activity' })"
        @create="creating = { projectId: selectedProject()!.id }"
        @task="(id) => navigate({ name: 'task', taskId: id })"
        @ask="managerOpen = !managerOpen"
      />
      <section
        v-if="managerOpen && route.name === 'project'"
        class="product-manager-note product-page"
        aria-label="项目经理摘要"
      >
        <h2>项目进展摘要</h2>
        <p>
          当前有 {{ projectTasks(route.projectId).length }} 个工作目标、{{
            projectDecisions(route.projectId).length
          }}
          项待决策。
        </p>
        <p>
          建议优先阅读待审阅的阶段资料，再确认是否继续推进。此摘要由项目状态整理；实时项目经理对话尚未接入。
        </p>
        <button
          class="product-secondary-action"
          @click="
            creating = {
              projectId: route.name === 'project' ? route.projectId : undefined,
            }
          "
        >
          提出新的工作目标
        </button>
      </section>
    </template>
    <main
      v-else-if="route.name === 'task' && selectedTask"
      class="product-page product-task-page"
    >
      <button
        class="product-back-link"
        @click="
          navigate({ name: 'project', projectId: selectedTask.projectId })
        "
      >
        返回项目空间
      </button>
      <TaskWorkspace
        :key="selectedTask.id"
        :task="selectedTask"
        :artifacts="product.artifactsByTask.value.get(selectedTask.id) || []"
        @refresh="product.refresh"
        @notify="(message) => (notice = message)"
        @run="navigate({ name: 'launch', taskId: selectedTask.id })"
      />
    </main>
    <main
      v-else-if="route.name === 'launch' && launchTask"
      class="product-page product-task-page"
    >
      <button
        class="product-back-link"
        @click="navigate({ name: 'task', taskId: launchTask.id })"
      >
        返回工作目标
      </button>
      <RunWorkspace
        :key="launchTask.id"
        :task="launchTask"
        :artifacts="product.artifactsByTask.value.get(launchTask.id) || []"
        :state="product.state.value"
        :local="product.local.value"
        @refresh="product.refresh"
        @notify="(message) => (notice = message)"
        @environment="navigate({ name: 'settings' })"
        @task="navigate({ name: 'task', taskId: launchTask.id })"
      />
    </main>
    <main
      v-else-if="route.name === 'execution' && executionTask"
      class="product-page product-task-page"
    >
      <button
        class="product-back-link"
        @click="
          navigate({ name: 'project', projectId: executionTask.projectId })
        "
      >
        返回项目空间
      </button>
      <RunWorkspace
        :key="executionRun!.id"
        :task="executionTask"
        :artifacts="product.artifactsByTask.value.get(executionTask.id) || []"
        :state="product.state.value"
        :local="product.local.value"
        :initial-run-id="executionRun!.id"
        @refresh="product.refresh"
        @notify="(message) => (notice = message)"
        @environment="navigate({ name: 'settings' })"
        @task="navigate({ name: 'task', taskId: executionTask.id })"
      />
    </main>
    <main
      v-else-if="route.name === 'settings'"
      class="product-page product-settings"
    >
      <header class="product-page-heading">
        <div>
          <span class="product-kicker">SETTINGS</span>
          <h1>环境设置。</h1>
          <p>连接你信任的执行环境和模型服务。</p>
        </div>
      </header>
      <EnvironmentPanel
        :status="product.local.value"
        :daemons="product.state.value.daemons"
        :error="''"
        @refresh="product.refresh"
        @notify="(message) => (notice = message)"
      />
    </main>
    <DeliveryView
      v-else-if="route.name === 'deliveries'"
      :projects="product.projects.value"
      :artifacts="allArtifacts()"
      @back="navigate({ name: 'inbox' })"
    />
    <ActivityView
      v-else-if="route.name === 'activity'"
      :runs="product.state.value.runs"
      :sessions="product.state.value.sessions"
      :tasks="product.state.value.tasks"
      @back="navigate({ name: 'inbox' })"
    />
    <main v-else class="product-placeholder" aria-live="polite">
      <span class="product-kicker">TITAN / PRODUCT</span>
      <h1>找不到这个项目空间</h1>
      <p>请返回决策收件箱，从真实项目状态重新进入。</p>
      <button
        class="product-secondary-action"
        @click="navigate({ name: 'inbox' })"
      >
        返回我的决策
      </button>
    </main>
  </ProductShell>
  <div v-if="notice" class="product-notice" role="status">
    {{ notice }}<button aria-label="关闭提示" @click="notice = ''">关闭</button>
  </div>
  <GoalDialog
    v-if="creating"
    :project-id="creating.projectId"
    @close="creating = null"
    @created="created"
  />
</template>
