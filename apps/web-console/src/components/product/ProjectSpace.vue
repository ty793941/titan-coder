<script setup lang="ts">
import {
  ArrowRight,
  CircleAlert,
  FileText,
  MessageCircle,
  Radio,
} from "lucide-vue-next";
import type { Artifact, Project, Run, Task } from "../../types";
import type { ProductDecision } from "../../product/types";
import { stageLabel, statusLabel } from "../../workflow";

defineProps<{
  project: Project;
  tasks: Task[];
  decisions: ProductDecision[];
  artifacts: Artifact[];
  activeRuns: Run[];
}>();
const emit = defineEmits<{
  decision: [id: string];
  deliveries: [];
  activity: [];
  ask: [];
  create: [];
  task: [id: string];
}>();
</script>

<template>
  <main class="product-page product-project-space">
    <header class="product-project-heading">
      <div>
        <span class="product-kicker">PROJECT SPACE</span>
        <h1>{{ project.name }}<span class="product-period">。</span></h1>
        <span class="product-goal-label">项目目标</span>
        <p>{{ project.goal }}</p>
      </div>
      <button class="product-secondary-action" @click="emit('ask')">
        <MessageCircle :size="15" />询问项目经理
      </button>
    </header>
    <section class="product-health-strip">
      <div>
        <span>当前关注状态</span
        ><strong>{{ decisions.length ? "需要关注" : "暂无待决策" }}</strong>
      </div>
      <div>
        <span>进行中的工作</span
        ><strong
          >{{
            tasks.filter((task) => task.status === "active").length
          }}
          项</strong
        >
      </div>
      <div>
        <span>活动 Run</span><strong>{{ activeRuns.length }} 个</strong>
      </div>
      <div>
        <span>交付物</span><strong>{{ artifacts.length }} 个版本</strong>
      </div>
    </section>
    <section class="product-project-grid">
      <div class="product-project-story">
        <div class="product-section-heading">
          <span class="product-kicker">PROJECT STORY</span>
          <h2>从目标走到交付</h2>
        </div>
        <div v-if="tasks.length" class="product-story-list">
          <article
            v-for="task in tasks"
            :key="task.id"
            class="product-story-item"
          >
            <span class="product-story-line" />
            <div>
              <span class="product-story-stage">{{
                stageLabel(task.stage)
              }}</span>
              <h3>
                <button
                  class="product-text-button"
                  @click="emit('task', task.id)"
                >
                  {{ task.title }} <ArrowRight :size="14" />
                </button>
              </h3>
              <p>{{ task.goal }}</p>
              <small
                >{{ statusLabel(task.status) }} · v{{ task.version }}</small
              >
            </div>
          </article>
        </div>
        <div v-else class="product-project-empty">
          还没有工作目标，先定义你希望实现的结果。
        </div>
        <button class="product-secondary-action" @click="emit('create')">
          添加工作目标 <ArrowRight :size="14" />
        </button>
      </div>
      <aside class="product-project-side">
        <div class="product-section-heading">
          <span class="product-kicker">NEEDS YOUR ATTENTION</span>
          <h2>待决策</h2>
        </div>
        <button
          v-for="item in decisions"
          :key="item.id"
          class="product-project-decision"
          @click="emit('decision', item.id)"
        >
          <CircleAlert :size="16" /><span
            ><strong>{{ item.title }}</strong
            ><small>{{ item.summary }}</small></span
          ><ArrowRight :size="14" />
        </button>
        <p v-if="!decisions.length" class="product-project-empty">
          当前没有需要你处理的事项。
        </p>
      </aside>
    </section>
    <section class="product-project-lower">
      <button class="product-lower-card" @click="emit('deliveries')">
        <FileText :size="18" /><span
          ><strong>最近交付物</strong
          ><small>{{
            artifacts.length
              ? `已有 ${artifacts.length} 个真实版本可追溯`
              : "还没有登记交付物"
          }}</small></span
        ><ArrowRight :size="15" /></button
      ><button class="product-lower-card" @click="emit('activity')">
        <Radio :size="18" /><span
          ><strong>项目活动</strong
          ><small>{{
            activeRuns.length
              ? "有运行正在产生进展"
              : "查看项目经理和 Agent 的最近活动"
          }}</small></span
        ><ArrowRight :size="15" />
      </button>
    </section>
  </main>
</template>
