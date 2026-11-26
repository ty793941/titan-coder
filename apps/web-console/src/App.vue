<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { ArrowRight } from "lucide-vue-next";
import AcceptanceConsole from "./components/AcceptanceConsole.vue";
import DecisionInbox from "./components/product/DecisionInbox.vue";
import DecisionDetail from "./components/product/DecisionDetail.vue";
import ProjectSpace from "./components/product/ProjectSpace.vue";
import DeliveryView from "./components/product/DeliveryView.vue";
import ActivityView from "./components/product/ActivityView.vue";
import ProductShell from "./components/product/ProductShell.vue";
import { parseProductRoute, productRoute, type ProductRoute } from "./product/routes";
import { useProductData } from "./product/useProductData";
import type { Artifact } from "./types";

const route = ref<ProductRoute>(parseProductRoute(window.location.hash));
const product = useProductData();

function updateRoute() {
  route.value = parseProductRoute(window.location.hash);
}

function navigate(next: ProductRoute) {
  window.location.hash = productRoute(next);
}
function openExecution(runId: string) {
  navigate({ name: "acceptance", runId });
}

const allArtifacts = () =>
  [...product.artifactsByTask.value.entries()].flatMap(([taskId, artifacts]) =>
    artifacts.map((artifact) => ({ ...artifact, taskId })),
  );
const selectedDecision = () =>
  product.decisions.value.find(
    (item) => route.value.name === "decision" && item.id === route.value.decisionId,
  );
const selectedProject = () =>
  product.projects.value.find(
    (item) => route.value.name === "project" && item.id === route.value.projectId,
  );
const projectTasks = (projectId: string) =>
  product.state.value.tasks.filter((task) => task.projectId === projectId);
const projectDecisions = (projectId: string) =>
  product.decisions.value.filter((item) => item.projectId === projectId);
const projectArtifacts = (projectId: string): Array<Artifact & { projectId: string }> => {
  const taskIds = new Set(projectTasks(projectId).map((task) => task.id));
  return allArtifacts()
    .filter((artifact) => taskIds.has(artifact.taskId))
    .map((artifact) => ({ ...artifact, projectId }));
};
const projectRuns = (projectId: string) => {
  const sessionIds = new Set(product.state.value.sessions.filter((session) => session.taskId && projectTasks(projectId).some((task) => task.id === session.taskId)).map((session) => session.id));
  return product.state.value.runs.filter((run) => sessionIds.has(run.sessionId));
};

window.addEventListener("hashchange", updateRoute);
onBeforeUnmount(() => window.removeEventListener("hashchange", updateRoute));
</script>

<template>
  <AcceptanceConsole v-if="route.name === 'acceptance'" :initial-run-id="route.runId" />
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
    />
    <main v-else-if="route.name === 'projects'" class="product-page product-list-page">
      <header class="product-page-heading"><div><span class="product-kicker">PROJECTS / YOUR PORTFOLIO</span><h1>项目<span class="product-period">。</span></h1><p>从目标、风险和交付状态进入每个项目空间。</p></div></header>
      <section class="product-project-directory"><button v-for="project in product.projects.value" :key="project.id" class="product-directory-item" @click="navigate({ name: 'project', projectId: project.id })"><span><strong>{{ project.name }}</strong><small>{{ project.goal }}</small></span><span class="product-directory-state">查看项目 <ArrowRight :size="14" /></span></button><p v-if="!product.projects.value.length" class="product-project-empty">还没有项目。请从项目经理开始定义第一个目标。</p></section>
    </main>
    <DecisionDetail
      v-else-if="route.name === 'decision' && selectedDecision()"
      :decision="selectedDecision()!"
      :on-refresh="product.refresh"
      @back="navigate({ name: 'inbox' })"
      @project="(id) => navigate({ name: 'project', projectId: id })"
      @completed="product.refresh"
      @execution="openExecution"
    />
    <ProjectSpace
      v-else-if="route.name === 'project' && selectedProject()"
      :project="selectedProject()!"
      :tasks="projectTasks(selectedProject()!.id)"
      :decisions="projectDecisions(selectedProject()!.id)"
      :artifacts="projectArtifacts(selectedProject()!.id)"
      :active-runs="projectRuns(selectedProject()!.id)"
      @decision="(id) => navigate({ name: 'decision', decisionId: id })"
      @deliveries="navigate({ name: 'deliveries' })"
      @activity="navigate({ name: 'activity' })"
    />
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
      <span class="product-kicker">TITAN / PRODUCT</span><h1>找不到这个项目空间</h1><p>请返回决策收件箱，从真实项目状态重新进入。</p><button class="product-secondary-action" @click="navigate({ name: 'inbox' })">返回我的决策</button>
    </main>
  </ProductShell>
</template>
