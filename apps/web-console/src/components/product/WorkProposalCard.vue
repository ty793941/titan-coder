<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { ArrowRight, CheckCheck, FileText } from "lucide-vue-next";
import { proposalChecksumSchema, workProposalSchema } from "@titan/contracts";
import type { ConversationTurn } from "@titan/contracts";
import { api, ApiError } from "../../api";
import type { WorkProposalAccepted } from "../../api";
import { productErrorMessage } from "../../product/errors";

const props = defineProps<{
  projectId: string;
  turn: ConversationTurn;
  csrfToken?: string;
}>();
const emit = defineEmits<{
  accepted: [result: WorkProposalAccepted];
  task: [id: string];
  review: [id: string];
  reload: [];
}>();
const proposal = computed(() => {
  if (
    props.turn.status !== "completed" ||
    props.turn.mode !== "work-proposal" ||
    !proposalChecksumSchema.safeParse(props.turn.proposalChecksum).success
  )
    return undefined;
  const parsed = workProposalSchema.safeParse(props.turn.proposal);
  return parsed.success ? parsed.data : undefined;
});
const saving = ref(false);
const conflict = ref(false);
const error = ref("");
const result = ref<WorkProposalAccepted>();
let alive = true;
onBeforeUnmount(() => {
  alive = false;
});
async function accept() {
  if (
    !proposal.value ||
    !props.csrfToken ||
    saving.value ||
    result.value ||
    conflict.value
  )
    return;
  saving.value = true;
  error.value = "";
  try {
    const saved = await api.acceptWorkProposal(
      props.projectId,
      {
        turnId: props.turn.id,
        proposalChecksum: props.turn.proposalChecksum!,
        confirmed: true,
      },
      props.csrfToken,
    );
    if (!alive) return;
    result.value = saved;
    emit("accepted", saved);
  } catch (caught) {
    if (!alive) return;
    conflict.value = caught instanceof ApiError && caught.status === 409;
    error.value = productErrorMessage(caught);
  } finally {
    if (alive) saving.value = false;
  }
}
const priorityLabel = computed(() =>
  proposal.value
    ? { low: "低", medium: "普通", high: "高", critical: "紧急" }[
        proposal.value.priority
      ]
    : "",
);
</script>

<template>
  <section v-if="proposal" class="proposal-card" aria-label="工作提案">
    <header>
      <span class="proposal-label"
        ><FileText :size="16" />工作提案 ·
        {{ result ? "已保存" : "等待确认" }}</span
      ><span class="proposal-priority">优先级：{{ priorityLabel }}</span>
    </header>
    <h3>{{ proposal.title }}</h3>
    <p class="proposal-goal">{{ proposal.goal }}</p>
    <h4>成功标准</h4>
    <ul>
      <li
        v-for="(criterion, index) in proposal.acceptanceCriteria"
        :key="index"
      >
        {{ criterion }}
      </li>
    </ul>
    <details open>
      <summary>问题确认草稿 · 全文</summary>
      <pre>{{ proposal.questions }}</pre>
    </details>
    <p class="proposal-boundary">
      此提案尚需人工判断。确认只建立工作目标和待审批草稿，不会批准阶段或启动执行。需要修改时，请补充要求后重新生成。
    </p>
    <p v-if="result" class="proposal-saved" role="status">
      <CheckCheck :size="17" />目标和草稿已保存，草稿仍待审批。
    </p>
    <div v-if="error" class="product-detail-error" role="alert">
      {{ error
      }}<button
        v-if="conflict"
        class="product-text-button"
        @click="emit('reload')"
      >
        重新读取历史
      </button>
    </div>
    <footer v-if="result">
      <button
        class="product-secondary-action"
        @click="emit('task', result.task.id)"
      >
        查看工作目标 <ArrowRight :size="14" /></button
      ><button
        class="product-primary-action"
        @click="emit('review', result.artifact.artifactId)"
      >
        进入草稿审批 <ArrowRight :size="14" />
      </button>
    </footer>
    <footer v-else>
      <span>确认的是当前显示的保存版本。刷新后再次确认会返回原目标。</span
      ><button
        data-action="accept-proposal"
        class="product-primary-action"
        :disabled="saving || conflict || !csrfToken"
        @click="accept"
      >
        {{ saving ? "正在保存…" : "确认建立目标与草稿" }}
        <ArrowRight :size="14" />
      </button>
    </footer>
  </section>
</template>

<style scoped>
.proposal-card {
  min-width: 0;
  margin-top: 20px;
  padding: 24px;
  border: 1px solid var(--product-line);
  border-top: 3px solid var(--product-accent);
  border-radius: 8px;
  background: var(--product-surface);
}
.proposal-card header,
.proposal-card footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.proposal-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--product-accent);
  font-size: 13px;
  font-weight: 600;
}
.proposal-priority {
  color: var(--product-soft-ink);
  font-size: 12px;
}
.proposal-card h3 {
  margin: 20px 0 10px;
  font: 600 24px/1.4 var(--product-serif);
  overflow-wrap: anywhere;
}
.proposal-card h4 {
  margin: 22px 0 8px;
  font-size: 14px;
}
.proposal-goal,
.proposal-card li {
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.proposal-card ul {
  padding-left: 20px;
  margin: 0;
}
.proposal-card details {
  margin-top: 24px;
  border-block: 1px solid var(--product-line);
}
.proposal-card summary {
  padding: 16px 0;
  cursor: pointer;
  font-size: 14px;
}
.proposal-card pre {
  margin: 0 0 18px;
  font-family: inherit;
  font-size: 15px;
  line-height: 1.9;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.proposal-boundary,
.proposal-card footer > span {
  color: var(--product-soft-ink);
  font-size: 12px;
  line-height: 1.8;
}
.proposal-boundary {
  margin-top: 18px;
}
.proposal-card footer {
  margin-top: 24px;
}
.proposal-card footer > span {
  flex: 1;
  min-width: 140px;
}
.proposal-saved {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
  color: var(--product-accent);
}
.proposal-card .product-detail-error {
  margin-top: 16px;
}
@media (max-width: 768px) {
  .proposal-card {
    padding: 18px;
  }
  .proposal-card footer {
    align-items: stretch;
    flex-direction: column;
  }
  .proposal-card .proposal-goal,
  .proposal-card li,
  .proposal-card pre {
    font-size: 16px;
  }
}
</style>
