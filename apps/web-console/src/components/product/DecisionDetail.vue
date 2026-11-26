<script setup lang="ts">
import { ArrowLeft, ArrowRight, CircleCheck, FileCheck2, RotateCcw } from "lucide-vue-next";
import { ref } from "vue";
import { api, ApiError, errorMessage } from "../../api";
import type { ProductDecision } from "../../product/types";

const props = defineProps<{
  decision: ProductDecision;
  onRefresh?: () => void | Promise<void>;
}>();
const emit = defineEmits<{ back: []; project: [id: string]; completed: []; execution: [runId: string] }>();
const busy = ref(false);
const success = ref(false);
const error = ref("");

async function act() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (props.decision.type === "execution_attention" && props.decision.runId) {
      emit("execution", props.decision.runId);
      return;
    }
    if (props.decision.type === "review_artifact" && props.decision.artifactId) {
      await api.approveArtifact(props.decision.artifactId);
    } else if (
      props.decision.type === "advance_stage" &&
      props.decision.nextStage &&
      props.decision.expectedVersion !== undefined
    ) {
      await api.advanceStage(
        props.decision.taskId,
        props.decision.nextStage,
        props.decision.expectedVersion,
      );
    } else {
      error.value = "这个事项需要从执行详情继续处理。";
      return;
    }
    success.value = true;
    await props.onRefresh?.();
    emit("completed");
  } catch (caught) {
    error.value = caught instanceof ApiError && caught.status === 409
      ? "内容已更新，请重新审阅后再做决定。"
      : errorMessage(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
    <main class="product-page product-decision-detail">
    <button class="product-back-link" @click="emit('back')"><ArrowLeft :size="15" />返回我的决策</button>
    <header class="product-detail-heading">
      <div><span class="product-kicker">DECISION / {{ decision.priority.toUpperCase() }}</span><h1>{{ decision.title }}<span class="product-period">。</span></h1><p>{{ decision.summary }}</p></div>
      <span class="product-detail-type"><FileCheck2 :size="16" />需要你的判断</span>
    </header>
    <div class="product-detail-grid">
      <section class="product-detail-main">
        <article class="product-detail-section"><span class="product-section-number">01</span><div><h2>发生了什么</h2><p>{{ decision.summary }}</p></div></article>
        <article class="product-detail-section"><span class="product-section-number">02</span><div><h2>为什么现在需要你决定</h2><p>{{ decision.whyNow }}</p></div></article>
        <article class="product-detail-section product-detail-recommendation"><span class="product-section-number">03</span><div><h2>项目经理建议</h2><p>{{ decision.recommendation }}</p></div><CircleCheck :size="22" /></article>
        <article class="product-detail-section"><span class="product-section-number">04</span><div><h2>可能的影响</h2><p>{{ decision.impact }}</p></div></article>
      </section>
      <aside class="product-detail-action"><span class="product-kicker">YOUR DECISION</span><h2>{{ success ? "已完成这个决定" : "现在处理" }}</h2><p>{{ success ? "项目状态正在刷新，后续阶段会根据新的事实更新。" : "确认前请阅读上面的背景、建议和影响。" }}</p><button class="product-primary-action" :disabled="busy || success" @click="act">{{ busy ? "处理中…" : success ? "已完成" : decision.actionLabel }}<ArrowRight v-if="!success" :size="15" /></button><p v-if="error" class="product-detail-error" role="alert">{{ error }}<button v-if="error.includes('更新')" class="product-retry" @click="error = ''"><RotateCcw :size="13" />重新审阅</button></p><button class="product-detail-project" @click="emit('project', decision.projectId)">查看所属项目 <ArrowRight :size="14" /></button></aside>
    </div>
  </main>
</template>
