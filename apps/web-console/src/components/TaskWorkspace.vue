<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  ArrowRight,
  Check,
  ChevronRight,
  ListChecks,
  CornerDownRight,
  FileCheck2,
  Play,
} from "lucide-vue-next";
import { api, ApiError, errorMessage } from "../api";
import type { Artifact, Task } from "../types";
import {
  stages,
  stageLabel,
  approvedChain,
  latestArtifact,
  shortId,
} from "../workflow";
import ArtifactEditor from "./ArtifactEditor.vue";
import StatusBadge from "./StatusBadge.vue";
const props = defineProps<{
  task: Task;
  artifacts: Artifact[];
  artifactsError?: string;
}>();
const emit = defineEmits<{ refresh: []; notify: [message: string]; run: [] }>();
const selectedStage = ref<string>(props.task.stage);
watch(
  () => [props.task.id, props.task.stage],
  () => {
    selectedStage.value = props.task.stage;
  },
);
const currentIndex = computed(() =>
  stages.findIndex((stage) => stage.id === props.task.stage),
);
const next = computed(() =>
  currentIndex.value >= 0 ? stages[currentIndex.value + 1] : undefined,
);
const approvedCount = computed(
  () =>
    stages
      .slice(0, 5)
      .filter(
        (stage) =>
          latestArtifact(props.artifacts, stage.id)?.reviewState === "approved",
      ).length,
);
const canAdvance = computed(
  () => !!next.value && approvedChain(props.artifacts, props.task.stage),
);
const busy = ref(false);
const error = ref("");
async function advance() {
  if (!next.value || !canAdvance.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api.advanceStage(props.task.id, next.value.id, props.task.version);
    emit("refresh");
    emit("notify", `任务已推进至${next.value.label}。`);
  } catch (caught) {
    error.value =
      caught instanceof ApiError && caught.status === 409
        ? "任务版本已变化，已请求刷新。请审阅最新版本后重试。"
        : errorMessage(caught);
    emit("refresh");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="task-detail-heading">
    <div>
      <div class="eyebrow">
        <span class="mono" :title="task.id">{{ shortId(task.id) }}</span
        ><ChevronRight :size="12" />VERSION {{ task.version }}
      </div>
      <h2>{{ task.title }}</h2>
      <p>{{ task.goal }}</p>
    </div>
    <StatusBadge :status="task.status" />
  </div>
  <section class="pipeline-panel panel">
    <div class="panel-heading">
      <div>
        <h3>从目标到执行</h3>
        <p>QRSPI 六阶段 · 逐步审阅，明确批准</p>
      </div>
      <span class="count-label"
        ><strong>{{ approvedCount }}</strong> / 5 已批准</span
      >
    </div>
    <ol class="stage-rail">
      <li
        v-for="(stage, index) in stages"
        :key="stage.id"
        :class="{
          current: task.stage === stage.id,
          selected: selectedStage === stage.id,
          done: index < currentIndex,
        }"
      >
        <button
          :aria-current="selectedStage === stage.id ? 'step' : undefined"
          @click="selectedStage = stage.id"
        >
          <span class="stage-number"
            ><Check v-if="index < currentIndex" :size="15" /><span v-else>{{
              String(index + 1).padStart(2, "0")
            }}</span></span
          ><strong>{{ stage.label }}</strong
          ><span class="stage-caption"
            >{{ stage.short }} /
            {{
              task.stage === stage.id
                ? "当前阶段"
                : latestArtifact(artifacts, stage.id)?.reviewState ===
                    "approved"
                  ? "已批准"
                  : "待准备"
            }}</span
          >
        </button>
      </li>
    </ol>
  </section>
  <p v-if="artifactsError" role="alert" class="notice error">
    工件读取失败：{{ artifactsError }}
  </p>
  <div class="task-content-grid">
    <div class="task-main-column">
      <ArtifactEditor
        v-if="stages.slice(0, 5).some((stage) => stage.id === selectedStage)"
        :key="`${task.id}-${selectedStage}`"
        :task-id="task.id"
        :type="selectedStage"
        :artifacts="artifacts"
        @refresh="emit('refresh')"
        @notify="(message) => emit('notify', message)"
      />
      <section v-else class="panel implementation-ready">
        <div class="icon-tile large"><Play :size="27" /></div>
        <span class="eyebrow">EXECUTION GATE</span>
        <h3>
          {{
            task.stage === "implement" ? "准备开始本机运行" : "先完成阶段准备"
          }}
        </h3>
        <p>
          批准最新计划后，选择模型、执行设备与授权工作区。所有运行都会保留事件和产物证据。
        </p>
        <button class="button primary" @click="emit('run')">
          进入运行面板<ArrowRight :size="16" />
        </button>
      </section>
      <div v-if="next" class="next-stage-bar">
        <div>
          <CornerDownRight :size="19" />
          <div>
            <strong>下一步：{{ next.label }}</strong>
            <p>
              {{
                canAdvance
                  ? "当前审批链有效，可推进阶段。"
                  : `请先保存并批准最新${stageLabel(task.stage)}工件。`
              }}
            </p>
          </div>
        </div>
        <button
          class="button primary"
          :disabled="busy || !canAdvance"
          @click="advance"
        >
          {{ busy ? "推进中…" : "推进下一阶段" }}<ArrowRight :size="15" />
        </button>
      </div>
      <p v-if="error" role="alert" class="inline-error">{{ error }}</p>
    </div>
    <aside class="task-aside">
      <section class="panel acceptance-panel">
        <div class="panel-heading">
          <ListChecks :size="17" />
          <h3>验收标准</h3>
        </div>
        <ol>
          <li
            v-for="(criterion, index) in task.acceptanceCriteria"
            :key="index"
          >
            <span class="criterion-index">{{
              String(index + 1).padStart(2, "0")
            }}</span
            ><span>{{ criterion }}</span>
          </li>
        </ol>
        <p class="field-help">执行结果需要对照标准人工验收。</p>
      </section>
      <div class="review-note">
        <FileCheck2 :size="20" />
        <h4>每一步，都有依据</h4>
        <p>
          工件保留独立版本、来源和 SHA-256。更新上游内容后，下游必须重新审阅。
        </p>
        <span class="eyebrow">TRACEABLE BY DESIGN</span>
      </div>
    </aside>
  </div>
</template>
