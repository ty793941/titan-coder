<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  FileText,
  Save,
  ShieldCheck,
  RefreshCw,
  Check,
  GitBranch,
} from "lucide-vue-next";
import { api, errorMessage } from "../api";
import type { Artifact } from "../types";
import {
  approvedChain,
  latestArtifact,
  stageLabel,
  stages,
  upstreamFor,
  shortId,
} from "../workflow";
import StatusBadge from "./StatusBadge.vue";
const props = defineProps<{
  taskId: string;
  type: string;
  artifacts: Artifact[];
}>();
const emit = defineEmits<{ refresh: []; notify: [message: string] }>();
const current = computed(() => latestArtifact(props.artifacts, props.type));
const upstream = computed(() => upstreamFor(props.artifacts, props.type));
const preparation = computed(() =>
  stages.slice(0, 5).some((item) => item.id === props.type),
);
const upstreamReady = computed(
  () =>
    props.type === "questions" ||
    (!!upstream.value && approvedChain(props.artifacts, upstream.value.type)),
);
const draft = ref("");
const dirty = ref(false);
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const mode = ref<"edit" | "preview">("edit");
const loadedId = ref("");
const stale = ref(false);
let controller: AbortController | undefined;
async function load() {
  controller?.abort();
  controller = new AbortController();
  const active = controller;
  const artifact = current.value;
  error.value = "";
  stale.value = false;
  loadedId.value = "";
  if (!artifact) {
    draft.value = "";
    dirty.value = false;
    loadedId.value = "";
    return;
  }
  loading.value = true;
  try {
    const result = await api.content(artifact.artifactId, active.signal);
    if (
      active.signal.aborted ||
      current.value?.artifactId !== artifact.artifactId
    )
      return;
    if (result.checksum !== artifact.checksum)
      throw new Error(
        "工件正文与版本校验信息不一致，已阻止批准。请刷新后重新读取。",
      );
    draft.value = result.content;
    dirty.value = false;
    loadedId.value = artifact.artifactId;
  } catch (caught) {
    if (!active.signal.aborted) error.value = errorMessage(caught);
  } finally {
    if (!active.signal.aborted) loading.value = false;
  }
}
watch(
  () => current.value?.artifactId,
  () => {
    if (dirty.value) stale.value = true;
    else void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());
async function save() {
  if (busy.value || !draft.value.trim() || !upstreamReady.value || stale.value)
    return;
  busy.value = true;
  error.value = "";
  try {
    await api.createArtifact(
      props.taskId,
      props.type,
      draft.value,
      upstream.value ? [upstream.value.artifactId] : [],
    );
    dirty.value = false;
    emit("refresh");
    emit("notify", "已保存新的工件版本。请审阅内容，再明确批准。");
  } catch (caught) {
    error.value = errorMessage(caught);
    emit("refresh");
  } finally {
    busy.value = false;
  }
}
async function approve() {
  if (!current.value || !canApprove.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api.approveArtifact(current.value.artifactId);
    emit("refresh");
    emit("notify", "当前工件已批准，可在任务面板推进下一阶段。");
  } catch (caught) {
    error.value = errorMessage(caught);
    emit("refresh");
  } finally {
    busy.value = false;
  }
}
const canApprove = computed(
  () =>
    preparation.value &&
    upstreamReady.value &&
    !!current.value &&
    !dirty.value &&
    !stale.value &&
    !loading.value &&
    loadedId.value === current.value.artifactId &&
    (!upstream.value ||
      current.value.sourceArtifacts.includes(upstream.value.artifactId)),
);
</script>

<template>
  <section class="panel artifact-editor">
    <div class="panel-heading">
      <div class="heading-with-icon">
        <FileText :size="18" />
        <div>
          <h3>{{ stageLabel(type) }}工件</h3>
          <p>
            {{
              current
                ? `版本 ${current.version} · 每次保存创建新版本`
                : "编写此阶段的目标、依据与执行约束"
            }}
          </p>
        </div>
      </div>
      <StatusBadge :status="current?.reviewState || 'draft'" />
    </div>
    <div class="editor-toolbar">
      <div class="segmented" aria-label="工件视图">
        <button :class="{ active: mode === 'edit' }" @click="mode = 'edit'">
          编辑 Markdown</button
        ><button
          :class="{ active: mode === 'preview' }"
          @click="mode = 'preview'"
        >
          纯文本预览
        </button>
      </div>
      <span class="editor-hint">{{
        loading
          ? "正在读取…"
          : dirty
            ? "有未保存修改"
            : current
              ? "已载入固定版本"
              : "尚未创建"
      }}</span>
    </div>
    <div v-if="stale" role="alert" class="notice warning editor-notice">
      <span>发现新的服务端版本，请重新载入后再编辑。当前输入尚未保存。</span
      ><button class="button small" @click="load">
        <RefreshCw :size="13" />重新载入
      </button>
    </div>
    <form @submit.prevent="save">
      <label :for="`artifact-${type}`" class="sr-only"
        >{{ stageLabel(type) }} Markdown 内容</label
      >
      <textarea
        v-show="mode === 'edit'"
        :id="`artifact-${type}`"
        v-model="draft"
        class="document-input"
        :disabled="loading || busy"
        spellcheck="false"
        maxlength="1000000"
        :placeholder="`# ${stageLabel(type)}\n\n记录可审阅的内容，保存后由你确认批准。`"
        @input="dirty = true"
      />
      <pre v-if="mode === 'preview'" class="document-preview">{{
        draft || "暂无内容。切换到编辑视图开始编写。"
      }}</pre>
      <div v-if="error" role="alert" class="inline-error editor-error">
        {{ error
        }}<button
          v-if="current && !dirty"
          type="button"
          class="text-link"
          @click="load"
        >
          重新读取
        </button>
      </div>
      <div class="editor-provenance">
        <GitBranch :size="14" /><span>{{
          upstream ? "引用直接上游" : "起始工件，无上游引用"
        }}</span
        ><code v-if="upstream" :title="upstream.artifactId"
          >{{ shortId(upstream.artifactId) }} · v{{ upstream.version }}</code
        >
      </div>
      <div v-if="!upstreamReady" class="field-help editor-error">
        请先完成并批准最新的直接上游工件。服务端会再次校验完整审批链。
      </div>
      <div class="editor-actions">
        <span class="helper-text"
          ><ShieldCheck :size="14" />保存不会自动批准</span
        >
        <div class="button-group">
          <button
            type="submit"
            class="button"
            :disabled="
              busy ||
              loading ||
              !dirty ||
              !draft.trim() ||
              !upstreamReady ||
              stale
            "
          >
            <Save :size="14" />{{ busy ? "处理中…" : "保存新版本" }}</button
          ><button
            v-if="current?.reviewState !== 'approved'"
            type="button"
            data-action="approve"
            class="button primary"
            :disabled="busy || !canApprove"
            @click="approve"
          >
            <ShieldCheck :size="14" />批准此版本</button
          ><span v-else class="approval-confirmed"
            ><Check :size="15" />此版本已批准</span
          >
        </div>
      </div>
    </form>
    <details v-if="current" class="metadata-details">
      <summary>版本与校验信息</summary>
      <dl>
        <dt>Artifact ID</dt>
        <dd>
          <code>{{ current.artifactId }}</code>
        </dd>
        <dt>SHA-256</dt>
        <dd>
          <code>{{ current.checksum }}</code>
        </dd>
        <dt>固定版本 URI</dt>
        <dd>
          <code>{{ current.uri }}</code>
        </dd>
        <dt>上游来源</dt>
        <dd>
          <code>{{ current.sourceArtifacts.join(", ") || "无" }}</code>
        </dd>
      </dl>
    </details>
  </section>
</template>
