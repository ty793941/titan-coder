<script setup lang="ts">
import { Activity, ArrowLeft } from "lucide-vue-next";
import type { Run, Session, Task } from "../../types";
import { formatTime, statusLabel } from "../../workflow";

const props = defineProps<{ runs: Run[]; sessions: Session[]; tasks: Task[] }>();
const taskForRun = (run: Run) => {
  const session = props.sessions.find((item) => item.id === run.sessionId);
  return props.tasks.find((task) => task.id === session?.taskId);
};
const emit = defineEmits<{ back: [] }>();
</script>

<template>
  <main class="product-page product-list-page">
    <button class="product-back-link" @click="emit('back')"><ArrowLeft :size="15" />返回我的决策</button>
    <header class="product-page-heading"><div><span class="product-kicker">ACTIVITY / PROJECT SIGNALS</span><h1>活动<span class="product-period">。</span></h1><p>只显示帮助项目负责人理解进展的项目级活动，技术细节保留在执行详情中。</p></div></header>
    <section class="product-activity-list"><article v-for="run in runs" :key="run.id" class="product-activity-item"><span class="product-activity-dot"><Activity :size="15" /></span><div><strong>{{ taskForRun(run)?.title || "项目执行" }}</strong><p>一次运行状态更新为“{{ statusLabel(run.status) }}”。</p><small>{{ formatTime(run.createdAt) }} · 第 {{ run.attempt }} 次尝试</small></div></article><p v-if="!runs.length" class="product-project-empty">当前没有新的项目级活动。</p></section>
  </main>
</template>
