<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  ArrowUpRight,
  MessageCircle,
  RefreshCw,
  Send,
  Square,
} from "lucide-vue-next";
import type {
  ConversationRequest,
  ConversationSnapshot,
  ConversationTurn,
} from "@titan/contracts";
import type { LocalStatus, Provider } from "../../types";
import { api, newRequestKey } from "../../api";
import type { WorkProposalAccepted } from "../../api";
import WorkProposalCard from "./WorkProposalCard.vue";
import { productErrorMessage } from "../../product/errors";
import { formatTime } from "../../workflow";

const props = defineProps<{ projectId: string; local: LocalStatus | null }>();
const emit = defineEmits<{
  settings: [];
  close: [];
  accepted: [result: WorkProposalAccepted];
  task: [id: string];
  review: [id: string];
}>();
const snapshot = ref<ConversationSnapshot>({
  projectId: props.projectId,
  turns: [],
});
const provider = ref<Provider>("codex");
const model = ref("");
const draft = ref("");
const loading = ref(true);
const submitting = ref(false);
const error = ref("");
const feed = ref<HTMLElement>();
const input = ref<HTMLTextAreaElement>();
const loaded = ref(false);
const chosen = ref(false);
const mode = ref<"question" | "work-proposal">("question");
const historyRevision = ref(0);
let alive = true;
let request: ConversationRequest | undefined;
let controller: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const running = computed(() =>
  snapshot.value.turns.find((turn) => turn.status === "running"),
);
const configured = computed(
  () =>
    props.local?.credentials.some(
      (item) =>
        item.provider === provider.value &&
        item.configured &&
        (item.provider !== "codex" || item.baseUrlConfigured),
    ) ?? false,
);
watch(
  () => props.local,
  (local) => {
    if (
      !chosen.value &&
      !local?.credentials.some(
        (item) =>
          item.provider === provider.value &&
          item.configured &&
          (item.provider !== "codex" || item.baseUrlConfigured),
      )
    ) {
      provider.value =
        local?.credentials.find(
          (item) =>
            item.configured &&
            (item.provider !== "codex" || item.baseUrlConfigured),
        )?.provider ?? "codex";
    }
  },
  { immediate: true },
);

function schedule() {
  clearTimeout(timer);
  if (alive && running.value)
    timer = setTimeout(() => {
      void load();
    }, 1500);
}
async function update(value: ConversationSnapshot) {
  if (!alive || value.projectId !== props.projectId) return;
  snapshot.value = value;
  if (
    request &&
    value.turns.some((turn) => turn.requestId === request!.requestId)
  ) {
    if (draft.value.trim() === request.text) draft.value = "";
    request = undefined;
  }
  await nextTick();
  if (feed.value) feed.value.scrollTop = feed.value.scrollHeight;
  schedule();
}
async function load() {
  controller?.abort();
  const active = (controller = new AbortController());
  try {
    const value = await api.conversation(props.projectId, active.signal);
    if (active.signal.aborted) return false;
    await update(value);
    loaded.value = true;
    error.value = "";
    return true;
  } catch (caught) {
    if (!active.signal.aborted && alive) {
      error.value = productErrorMessage(caught);
      schedule();
    }
  } finally {
    if (alive && !active.signal.aborted) loading.value = false;
  }
  return false;
}
async function reloadHistory() {
  if (await load()) historyRevision.value++;
}
async function send() {
  const text = draft.value.trim();
  if (
    !text ||
    submitting.value ||
    running.value ||
    !configured.value ||
    !props.local?.csrfToken ||
    !loaded.value
  )
    return;
  if (
    !request ||
    request.text !== text ||
    request.provider !== provider.value ||
    (request.modelRef ?? "") !== model.value.trim() ||
    request.mode !==
      (mode.value === "work-proposal" ? "work-proposal" : undefined)
  ) {
    request = {
      requestId: newRequestKey(),
      text,
      provider: provider.value,
      ...(mode.value === "work-proposal"
        ? { mode: "work-proposal" as const }
        : {}),
      ...(model.value.trim() ? { modelRef: model.value.trim() } : {}),
    };
  }
  submitting.value = true;
  error.value = "";
  try {
    await update(
      await api.sendConversation(
        props.projectId,
        request,
        props.local.csrfToken,
      ),
    );
  } catch (caught) {
    if (alive) error.value = productErrorMessage(caught);
  } finally {
    if (alive) submitting.value = false;
  }
}
async function cancel() {
  if (!running.value || submitting.value || !props.local?.csrfToken) return;
  submitting.value = true;
  try {
    await update(
      await api.cancelConversation(
        props.projectId,
        running.value.id,
        props.local.csrfToken,
      ),
    );
  } catch (caught) {
    error.value = productErrorMessage(caught);
  } finally {
    submitting.value = false;
  }
}
function retry(turn: ConversationTurn) {
  draft.value = turn.text;
  mode.value = turn.mode === "work-proposal" ? "work-proposal" : "question";
  provider.value = turn.provider;
  chosen.value = true;
  model.value = turn.modelRef ?? "";
  request = undefined;
  void nextTick(() => input.value?.focus());
}
watch(
  () => props.projectId,
  () => {
    clearTimeout(timer);
    controller?.abort();
    snapshot.value = { projectId: props.projectId, turns: [] };
    draft.value = "";
    mode.value = "question";
    request = undefined;
    loading.value = true;
    loaded.value = false;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  alive = false;
  clearTimeout(timer);
  controller?.abort();
});
</script>

<template>
  <section class="product-manager-chat product-page" aria-label="项目经理对话">
    <header class="manager-heading">
      <div>
        <span class="product-kicker">与你的项目经理一起推进</span>
        <h2><MessageCircle :size="22" />项目经理</h2>
        <p>带着当前项目目标和工作阶段，讨论风险与下一步。</p>
      </div>
      <div class="manager-heading-actions">
        <button
          class="product-icon-button"
          aria-label="刷新对话历史"
          :disabled="loading"
          @click="reloadHistory"
        >
          <RefreshCw :size="16" /></button
        ><button class="product-secondary-action" @click="emit('close')">
          收起对话
        </button>
      </div>
    </header>
    <div
      ref="feed"
      class="manager-feed"
      :class="{
        'has-proposals': snapshot.turns.some(
          (turn) =>
            turn.status === 'completed' &&
            turn.mode === 'work-proposal' &&
            turn.proposal,
        ),
      }"
      role="log"
      aria-live="polite"
      aria-label="对话记录"
    >
      <p v-if="loading" role="status">正在读取本机对话…</p>
      <div v-else-if="!snapshot.turns.length" class="manager-welcome">
        <span class="manager-avatar">T</span>
        <h3>先把最重要的问题说清楚。</h3>
        <p>
          可以询问“当前最需要关注什么？”或“下一阶段应该准备哪些依据？”。回复是建议，项目操作仍由你确认。
        </p>
      </div>
      <article
        v-for="turn in snapshot.turns"
        :key="turn.id"
        class="manager-turn"
      >
        <div class="manager-message is-user">
          <strong
            >你 <time>{{ formatTime(turn.createdAt) }}</time></strong
          >
          <p>{{ turn.text }}</p>
        </div>
        <div class="manager-message is-assistant">
          <strong
            >项目经理
            <span
              >{{ turn.provider === "codex" ? "Codex" : "Qwen"
              }}{{ turn.modelRef ? ` · ${turn.modelRef}` : "" }}</span
            ></strong
          >
          <p
            v-if="turn.status === 'running'"
            class="manager-thinking"
            role="status"
          >
            <span class="small-dot green" />{{
              turn.mode === "work-proposal"
                ? "正在整理目标与问题确认草稿…"
                : "正在整理项目背景并回复…"
            }}
          </p>
          <template v-else-if="turn.status === 'completed'">
            <p>{{ turn.reply }}</p>
            <WorkProposalCard
              v-if="turn.mode === 'work-proposal'"
              :key="`${turn.id}:${historyRevision}`"
              :project-id="projectId"
              :turn="turn"
              :csrf-token="local?.csrfToken"
              @accepted="(result) => emit('accepted', result)"
              @task="(id) => emit('task', id)"
              @review="(id) => emit('review', id)"
              @reload="reloadHistory"
            />
          </template>
          <template v-else
            ><p>
              {{
                turn.status === "cancelled"
                  ? "本轮回复已停止。"
                  : turn.errorCode === "CONVERSATION_INTERRUPTED"
                    ? "上次回复因本机服务重启而中断，未自动重试。"
                    : turn.errorCode === "CONVERSATION_PROPOSAL_INVALID"
                      ? "提案未通过结构或安全校验，没有创建工作目标。请补充要求后重新生成。"
                      : turn.errorCode === "CONVERSATION_TIMEOUT"
                        ? "本轮回复超时，请稍后重试。"
                        : "本轮回复未完成，请检查模型权限或网络后重试。"
              }}
            </p>
            <button class="product-text-button" @click="retry(turn)">
              重新编辑并发送 <ArrowUpRight :size="14" /></button
          ></template>
        </div>
      </article>
    </div>
    <form class="manager-composer" @submit.prevent="send">
      <div class="manager-intent">
        <label for="manager-mode">本次意图</label
        ><select
          id="manager-mode"
          v-model="mode"
          :disabled="submitting || !!running"
        >
          <option value="question">普通问答</option>
          <option value="work-proposal">生成工作提案</option></select
        ><span>{{
          mode === "work-proposal"
            ? "生成目标、成功标准与草稿，审阅后由你确认保存。"
            : "讨论项目背景、风险和下一步。"
        }}</span>
      </div>
      <div class="manager-model">
        <label for="manager-provider">模型服务</label
        ><select
          id="manager-provider"
          v-model="provider"
          :disabled="submitting || !!running"
          @change="
            chosen = true;
            model = '';
          "
        >
          <option value="codex">Codex · App Server</option>
          <option value="qwen">Qwen</option></select
        ><label for="manager-model">模型名称 <span>可选</span></label
        ><input
          id="manager-model"
          v-model="model"
          maxlength="120"
          :disabled="submitting || !!running"
          placeholder="留空使用默认模型"
        />
      </div>
      <p v-if="!configured" class="manager-config-note">
        尚未配置所选模型。<button
          type="button"
          class="product-text-button"
          @click="emit('settings')"
        >
          配置模型 <ArrowUpRight :size="14" />
        </button>
      </p>
      <label for="manager-question" class="sr-only">向项目经理提问</label
      ><textarea
        id="manager-question"
        ref="input"
        v-model="draft"
        rows="3"
        maxlength="4000"
        :disabled="submitting"
        placeholder="说说你关心的问题，或希望推进的方向…"
      />
      <div v-if="error" class="product-detail-error" role="alert">
        {{ error }}
        <button type="button" class="product-text-button" @click="load">
          重新同步
        </button>
      </div>
      <footer>
        <span
          >仅发送时调用所选模型，可能产生费用。对话保存在本机，不会自动执行项目操作。</span
        ><button
          v-if="running"
          type="button"
          class="product-secondary-action"
          :disabled="submitting"
          @click="cancel"
        >
          <Square :size="14" />停止回复</button
        ><button
          v-else
          type="submit"
          class="product-primary-action"
          :disabled="
            submitting ||
            !configured ||
            !loaded ||
            !draft.trim() ||
            draft.length > 4000
          "
        >
          <Send :size="15" />{{
            submitting
              ? "正在发送…"
              : mode === "work-proposal"
                ? "生成工作提案"
                : "发送问题"
          }}
        </button>
      </footer>
    </form>
  </section>
</template>

<style scoped>
.product-manager-chat {
  padding: 0;
  margin-bottom: 64px;
  border: 1px solid var(--product-line);
  border-radius: 12px;
  overflow: hidden;
  background: var(--product-surface);
  box-shadow: 0 10px 30px #183c3808;
}
.manager-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
  padding: 28px 32px;
  background: linear-gradient(120deg, #edf4ee, #fbfaf5);
  border-bottom: 1px solid var(--product-line);
}
.manager-heading h2 {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  font: 600 27px/1.3 var(--product-serif);
}
.manager-heading h2 svg {
  color: var(--product-accent);
}
.manager-heading p {
  margin-top: 8px;
  color: var(--product-soft-ink);
  font-size: 14px;
}
.manager-heading-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.manager-feed {
  max-height: 560px;
  min-height: 260px;
  overflow-y: auto;
  padding: 24px 32px;
  overscroll-behavior: contain;
}
.manager-welcome {
  max-width: 520px;
  padding: 24px 0;
  margin: auto;
  text-align: center;
}
.manager-feed.has-proposals {
  max-height: none;
}
.manager-welcome h3 {
  margin: 18px 0 10px;
  font: 600 22px var(--product-serif);
}
.manager-welcome p {
  color: var(--product-soft-ink);
  line-height: 1.8;
}
.manager-avatar {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  margin: auto;
  background: var(--product-accent-pale);
  color: var(--product-accent);
  border-radius: 50%;
  font:
    600 20px Georgia,
    serif;
}
.manager-turn {
  display: grid;
  gap: 18px;
  margin-bottom: 28px;
}
.manager-message {
  padding: 20px 24px;
  border-radius: 8px;
}
.manager-message strong {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--product-accent-dark);
}
.manager-message time,
.manager-message strong span {
  color: var(--product-soft-ink);
  font-size: 12px;
  font-weight: 400;
}
.manager-message p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.85;
}
.is-user {
  background: #f0f3eb;
  margin-left: 10%;
}
.is-assistant {
  border-left: 2px solid #a4c5b5;
  border-radius: 0;
  margin-right: 6%;
}
.manager-thinking {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--product-soft-ink);
}
.manager-composer {
  padding: 24px 32px;
  border-top: 1px solid var(--product-line);
  background: #f8f9f3;
}
.manager-model {
  display: grid;
  grid-template-columns: auto minmax(100px, 1fr) auto minmax(100px, 1fr);
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.manager-intent {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.manager-intent label {
  margin: 0;
  font-size: 12px;
}
.manager-intent select {
  width: auto;
  min-height: 44px;
}
.manager-intent > span {
  color: var(--product-soft-ink);
  font-size: 12px;
}
.manager-model label {
  font-size: 12px;
  margin: 0;
  white-space: nowrap;
}
.manager-model label span {
  color: var(--product-soft-ink);
}
.manager-model input,
.manager-model select {
  min-height: 44px;
  background: var(--product-surface);
}
.manager-composer textarea {
  background: var(--product-surface);
  min-height: 110px;
  font-size: 16px;
  border-radius: 8px;
}
.manager-composer footer {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: center;
  margin-top: 16px;
}
.manager-composer footer > span {
  max-width: 520px;
  color: var(--product-soft-ink);
  font-size: 12px;
  line-height: 1.7;
}
.manager-composer footer button {
  white-space: nowrap;
}
.manager-config-note {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0 14px;
  color: #815d31;
}
@media (max-width: 768px) {
  .manager-heading {
    flex-direction: column;
  }
  .manager-heading,
  .manager-feed,
  .manager-composer {
    padding: 20px;
  }
  .manager-model {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .manager-model input,
  .manager-model select {
    font-size: 16px;
  }
  .manager-composer footer {
    flex-direction: column;
    align-items: stretch;
  }
  .manager-message {
    padding: 16px;
  }
  .is-user {
    margin-left: 0;
  }
  .is-assistant {
    margin-right: 0;
  }
  .manager-heading-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
