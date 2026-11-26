<script setup lang="ts">
import { ArrowRight, CircleCheck, FolderOpen, Sparkles } from "lucide-vue-next";
import type { Project } from "../../types";
import type { ProductDecision } from "../../product/types";
import ProductEmptyState from "./ProductEmptyState.vue";

const props = defineProps<{
  decisions: ProductDecision[];
  projects: Project[];
  loading: boolean;
}>();
const emit = defineEmits<{
  decision: [id: string];
  project: [id: string];
}>();
const projectName = (id: string) => props.projects.find((project) => project.id === id)?.name || "未命名项目";
const priorityLabel = (priority: ProductDecision["priority"]) =>
  ({ critical: "高影响", high: "重要", medium: "普通", low: "低影响" })[priority];
</script>

<template>
  <div class="product-page product-inbox">
    <header class="product-page-heading">
      <div>
        <span class="product-kicker">DECISION DESK / TODAY</span>
        <h1>今天要决定的事<span class="product-period">。</span></h1>
        <p v-if="decisions.length">有 {{ decisions.length }} 项事项等待你的判断。先处理影响交付的决定。</p>
        <p v-else>项目经理会把真正需要你判断的事项带到这里。</p>
      </div>
      <div class="product-page-mark"><Sparkles :size="18" /><span>项目负责人工作台</span></div>
    </header>

    <div v-if="loading" class="product-loading" role="status">正在整理你的项目状态…</div>
    <ProductEmptyState
      v-else-if="!decisions.length"
      title="当前没有需要你决定的事项"
      description="项目正在按计划推进。你可以查看项目脉搏，或进入一个项目了解最近发生了什么。"
    />
    <template v-else>
      <section class="product-decision-layout" aria-label="决策队列">
        <div class="product-decision-list">
          <article v-for="item in decisions" :key="item.id" class="product-decision-card">
            <div class="product-card-meta">
              <span class="product-priority" :data-priority="item.priority">{{ priorityLabel(item.priority) }}</span>
              <button class="product-project-link" @click="emit('project', item.projectId)">{{ projectName(item.projectId) }} <ArrowRight :size="13" /></button>
            </div>
            <h2>{{ item.title }}</h2>
            <p class="product-card-summary">{{ item.summary }}</p>
            <div class="product-card-question"><strong>为什么现在需要你决定</strong><p>{{ item.whyNow }}</p></div>
            <div class="product-card-recommendation"><CircleCheck :size="17" /><div><strong>项目经理建议</strong><p>{{ item.recommendation }}</p></div></div>
            <div class="product-card-footer"><span>影响：{{ item.impact }}</span><button class="product-primary-action" @click="emit('decision', item.id)">处理此事项 <ArrowRight :size="15" /></button></div>
          </article>
        </div>
        <aside class="product-pulse-panel">
          <div class="product-aside-heading"><span class="product-kicker">PROJECT PULSE</span><h2>项目脉搏</h2></div>
          <div v-if="projects.length" class="product-pulse-list">
            <button v-for="project in projects" :key="project.id" class="product-pulse-item" @click="emit('project', project.id)"><span class="product-pulse-dot" /><span><strong>{{ project.name }}</strong><small>{{ project.goal }}</small></span><ArrowRight :size="14" /></button>
          </div>
          <ProductEmptyState v-else title="还没有项目" description="创建一个项目后，这里会显示它的健康状态和最近进展。" />
          <div class="product-pulse-note"><FolderOpen :size="16" /><span>项目经理会持续整理阶段、风险和交付证据。</span></div>
        </aside>
      </section>
    </template>
  </div>
</template>
