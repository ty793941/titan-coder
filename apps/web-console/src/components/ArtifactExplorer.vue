<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  FileText,
  Fingerprint,
  ArrowUpRight,
  GitBranch,
} from "lucide-vue-next";
import type { Artifact, ArtifactContent } from "../types";
import { api, errorMessage } from "../api";
import { stageLabel, shortId, formatTime } from "../workflow";
import StatusBadge from "./StatusBadge.vue";
import EmptyState from "./EmptyState.vue";
const props = defineProps<{ artifacts: Artifact[]; error?: string }>();
const selectedId = ref("");
const content = ref<ArtifactContent>();
const loading = ref(false);
const loadError = ref("");
const ordered = computed(() => [...props.artifacts].reverse());
const selected = computed(() =>
  props.artifacts.find((item) => item.artifactId === selectedId.value),
);
watch(
  ordered,
  (items) => {
    if (!items.some((item) => item.artifactId === selectedId.value))
      selectedId.value = items[0]?.artifactId || "";
  },
  { immediate: true },
);
let controller: AbortController | undefined;
watch(
  selectedId,
  async (value) => {
    controller?.abort();
    controller = new AbortController();
    const active = controller;
    content.value = undefined;
    loadError.value = "";
    if (!value) return;
    loading.value = true;
    try {
      const result = await api.content(value, active.signal);
      if (!active.signal.aborted) content.value = result;
    } catch (error) {
      if (!active.signal.aborted) loadError.value = errorMessage(error);
    } finally {
      if (!active.signal.aborted) loading.value = false;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section class="view-intro">
    <div>
      <div class="eyebrow">ARTIFACT REGISTRY</div>
      <h2>交付物，有据可查<span class="accent">.</span></h2>
      <p>审阅每一个固定版本、内容校验与上游来源。</p>
    </div>
    <span class="count-label">{{ artifacts.length }} 个工件版本</span>
  </section>
  <p v-if="error" role="alert" class="notice error">{{ error }}</p>
  <EmptyState
    v-if="!artifacts.length"
    class="panel"
    title="还没有工件"
    description="在任务面板编写阶段内容，或执行任务产出文件，工件将在这里登记。"
  />
  <div v-else class="artifact-explorer">
    <section class="panel artifact-list">
      <div class="list-caption">
        全部版本 <span>{{ artifacts.length }}</span>
      </div>
      <button
        v-for="artifact in ordered"
        :key="artifact.artifactId"
        :class="{ selected: selectedId === artifact.artifactId }"
        @click="selectedId = artifact.artifactId"
      >
        <FileText :size="17" />
        <div>
          <strong
            >{{ stageLabel(artifact.type)
            }}<span class="version-tag">v{{ artifact.version }}</span></strong
          ><code>{{ shortId(artifact.artifactId) }}</code
          ><StatusBadge :status="artifact.reviewState" />
        </div>
        <ArrowUpRight :size="13" />
      </button>
    </section>
    <section v-if="selected" class="panel artifact-viewer">
      <div class="panel-heading">
        <div>
          <h3>
            {{ stageLabel(selected.type) }}
            <span class="muted">/ v{{ selected.version }}</span>
          </h3>
          <p>
            {{ formatTime(selected.createdAt) }} ·
            {{ content?.bytes ?? "—" }} bytes
          </p>
        </div>
        <StatusBadge :status="selected.reviewState" />
      </div>
      <div class="artifact-fingerprint">
        <Fingerprint :size="16" /><code>{{ selected.checksum }}</code>
      </div>
      <p v-if="loading" class="viewer-loading" role="status">
        正在读取工件正文…
      </p>
      <p v-else-if="loadError" role="alert" class="inline-error editor-error">
        {{ loadError }}
      </p>
      <pre v-else class="artifact-body">{{
        content?.content || "此工件没有正文。"
      }}</pre>
      <div class="source-detail">
        <div class="heading-with-icon">
          <GitBranch :size="16" /><strong>来源与定位</strong>
        </div>
        <dl>
          <dt>Artifact ID</dt>
          <dd>
            <code>{{ selected.artifactId }}</code>
          </dd>
          <dt>版本 URI</dt>
          <dd>
            <code>{{ selected.uri }}</code>
          </dd>
          <dt>上游工件</dt>
          <dd v-if="!selected.sourceArtifacts.length" class="muted">
            无上游引用
          </dd>
          <dd v-else>
            <code v-for="source in selected.sourceArtifacts" :key="source">{{
              source
            }}</code>
          </dd>
        </dl>
      </div>
    </section>
  </div>
</template>
