<script setup lang="ts">
import { ArrowRight, CircleCheck, FolderOpen, Sparkles } from "lucide-vue-next";
import { computed, ref } from "vue";
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
  create: [];
}>();
const projectName = (id: string) =>
  props.projects.find((project) => project.id === id)?.name || "未命名项目";
const priorityLabel = (priority: ProductDecision["priority"]) =>
  ({ critical: "高影响", high: "重要", medium: "普通", low: "低影响" })[
    priority
  ];
const projectFilter = ref("");
const visibleDecisions = computed(() =>
  props.decisions.filter(
    (item) => !projectFilter.value || item.projectId === projectFilter.value,
  ),
);
</script>

<template>
  <div class="product-page product-inbox">
    <header class="product-page-heading">
      <div>
        <span class="product-kicker">DECISION DESK / TODAY</span>
        <h1>今天要决定的事<span class="product-period">。</span></h1>
        <p v-if="decisions.length">
          有 {{ decisions.length }} 项事项等待你的判断。先处理影响交付的决定。
        </p>
        <p v-else>项目经理会把真正需要你判断的事项带到这里。</p>
      </div>
      <div class="product-page-mark">
        <Sparkles :size="18" /><span>项目负责人工作台</span>
      </div>
    </header>
    <div class="product-inbox-filter">
      <label for="decision-project">关注项目</label
      ><select id="decision-project" v-model="projectFilter">
        <option value="">全部项目</option>
        <option
          v-for="project in projects"
          :key="project.id"
          :value="project.id"
        >
          {{ project.name }}
        </option></select
      ><span>{{ visibleDecisions.length }} 项待处理</span>
    </div>

    <div v-if="loading" class="product-loading" role="status">
      正在整理你的项目状态…
    </div>
    <template v-else>
      <section class="product-decision-layout" aria-label="决策队列">
        <div class="product-decision-list">
          <ProductEmptyState
            v-if="!visibleDecisions.length"
            title="当前没有需要你决定的事项"
            :description="
              projects.length
                ? '查看项目进展，或为项目添加新的工作目标。'
                : '从一个项目目标开始，把想法变成可以审阅的结果。'
            "
            :action-label="projects.length ? undefined : '创建第一个项目'"
            @action="emit('create')"
          />
          <article
            v-for="item in visibleDecisions"
            :key="item.id"
            :data-decision-id="item.id"
            class="product-decision-card"
          >
            <div class="product-card-meta">
              <span class="product-priority" :data-priority="item.priority">{{
                priorityLabel(item.priority)
              }}</span>
              <button
                class="product-project-link"
                @click="emit('project', item.projectId)"
              >
                {{ projectName(item.projectId) }} <ArrowRight :size="13" />
              </button>
            </div>
            <h2>{{ item.title }}</h2>
            <p class="product-card-summary">{{ item.summary }}</p>
            <div class="product-card-question">
              <strong>为什么现在需要你决定</strong>
              <p>{{ item.whyNow }}</p>
            </div>
            <div class="product-card-recommendation">
              <CircleCheck :size="17" />
              <div>
                <strong>建议下一步</strong>
                <p>{{ item.recommendation }}</p>
              </div>
            </div>
            <div class="product-card-footer">
              <span>影响：{{ item.impact }}</span
              ><button
                class="product-primary-action"
                @click="emit('decision', item.id)"
              >
                处理此事项 <ArrowRight :size="15" />
              </button>
            </div>
          </article>
        </div>
        <aside class="product-pulse-panel">
          <div class="product-aside-heading">
            <span class="product-kicker">PROJECT PULSE</span>
            <h2>项目脉搏</h2>
          </div>
          <div v-if="projects.length" class="product-pulse-list">
            <button
              v-for="project in projects
                .filter((item) => !projectFilter || item.id === projectFilter)
                .slice(0, 5)"
              :key="project.id"
              class="product-pulse-item"
              @click="emit('project', project.id)"
            >
              <span class="product-pulse-dot" /><span
                ><strong>{{ project.name }}</strong
                ><small>{{ project.goal }}</small></span
              ><ArrowRight :size="14" />
            </button>
          </div>
          <ProductEmptyState
            v-else
            title="还没有项目"
            description="创建一个项目后，这里会显示它的健康状态和最近进展。"
          />
          <div class="product-pulse-note">
            <FolderOpen :size="16" /><span
              >项目经理会持续整理阶段、风险和交付证据。</span
            >
          </div>
        </aside>
      </section>
    </template>
  </div>
</template>
