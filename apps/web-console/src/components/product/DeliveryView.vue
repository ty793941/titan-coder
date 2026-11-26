<script setup lang="ts">
import { ArrowLeft, FileText } from "lucide-vue-next";
import type { Artifact, Project } from "../../types";
import { formatTime, stageLabel } from "../../workflow";

defineProps<{ projects: Project[]; artifacts: Array<Artifact & { projectId?: string }> }>();
const emit = defineEmits<{ back: [] }>();
</script>

<template>
  <main class="product-page product-list-page">
    <button class="product-back-link" @click="emit('back')"><ArrowLeft :size="15" />返回我的决策</button>
    <header class="product-page-heading"><div><span class="product-kicker">DELIVERIES / TRACEABLE WORK</span><h1>交付物<span class="product-period">。</span></h1><p>查看真实版本、评审状态和来源，确保每个结果都能回到项目目标。</p></div></header>
    <section class="product-delivery-list"><article v-for="artifact in artifacts" :key="artifact.artifactId" class="product-delivery-item"><span class="product-delivery-icon"><FileText :size="17" /></span><div><strong>{{ stageLabel(artifact.type) }} · v{{ artifact.version }}</strong><span>{{ projects.find((project) => project.id === artifact.projectId)?.name || "项目交付物" }} · {{ formatTime(artifact.createdAt) }}</span></div><span class="product-delivery-status">{{ artifact.reviewState === "approved" ? "已批准" : artifact.reviewState === "changes_requested" ? "需修改" : "待评审" }}</span></article><p v-if="!artifacts.length" class="product-project-empty">目前还没有可以展示的真实交付物。</p></section>
  </main>
</template>
