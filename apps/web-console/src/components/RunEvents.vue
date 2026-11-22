<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { Radio, ChevronDown, Terminal, Fingerprint } from "lucide-vue-next";
import { api, ApiError, errorMessage } from "../api";
import type { RunEvent } from "../types";
import { formatTime } from "../workflow";
const props = defineProps<{ runId: string; status: string }>();
const events = ref<RunEvent[]>([]);
const connection = ref("connecting");
const error = ref("");
let controller: AbortController | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let cursor = 0;
let delay = 1500;
function stop() {
  controller?.abort();
  clearTimeout(retry);
}
async function connect() {
  controller = new AbortController();
  const active = controller;
  connection.value = events.value.length ? "reconnecting" : "connecting";
  try {
    await api.streamEvents(
      props.runId,
      (event) => {
        if (active.signal.aborted) return;
        if (!events.value.some((item) => item.eventId === event.eventId))
          events.value = [...events.value, event].slice(-500);
        cursor = Math.max(cursor, event.sequence);
        connection.value = "connected";
        error.value = "";
        delay = 1500;
      },
      active.signal,
      cursor,
    );
    if (active.signal.aborted) return;
    connection.value = "closed";
  } catch (caught) {
    if (active.signal.aborted) return;
    error.value = errorMessage(caught);
    connection.value = "reconnecting";
    if (caught instanceof ApiError && caught.code === "EVENT_SEQUENCE_GAP")
      cursor = 0;
  }
  if (
    !active.signal.aborted &&
    !["completed", "failed", "cancelled", "paused", "waiting_input"].includes(
      props.status,
    )
  ) {
    retry = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 15000);
  }
}
watch(
  () => props.runId,
  () => {
    stop();
    events.value = [];
    error.value = "";
    cursor = 0;
    delay = 1500;
    void connect();
  },
  { immediate: true },
);
onBeforeUnmount(stop);
function payload(event: RunEvent) {
  return typeof event.payload === "string"
    ? event.payload
    : JSON.stringify(event.payload, null, 2);
}
</script>

<template>
  <section class="panel event-panel">
    <div class="panel-heading">
      <div class="heading-with-icon">
        <Terminal :size="18" />
        <div>
          <h3>运行事件</h3>
          <p>按序接收事件 · 保留最近 500 条</p>
        </div>
      </div>
      <span class="stream-status" :class="{ live: connection === 'connected' }"
        ><Radio :size="13" />{{
          connection === "connected"
            ? "实时订阅"
            : connection === "reconnecting"
              ? "等待重连"
              : connection === "closed"
                ? "订阅结束"
                : "连接中"
        }}</span
      >
    </div>
    <p v-if="error" role="status" class="stream-notice">{{ error }}</p>
    <div v-if="!events.length" class="event-empty">
      <Radio :size="25" /><strong>等待运行事件</strong
      ><span>任务执行后，模型、工具与审批记录会显示在这里。</span>
    </div>
    <ol v-else class="event-list">
      <li v-for="event in events" :key="event.eventId">
        <div class="event-line">
          <span class="event-sequence">{{
            String(event.sequence).padStart(3, "0")
          }}</span
          ><span class="event-marker" /><strong>{{ event.eventType }}</strong
          ><time>{{ formatTime(event.occurredAt) }}</time>
        </div>
        <details v-if="event.payload !== undefined">
          <summary><ChevronDown :size="12" />查看事件内容</summary>
          <pre>{{ payload(event) }}</pre>
          <span v-if="event.traceId" class="event-trace"
            ><Fingerprint :size="12" /><code>{{ event.traceId }}</code></span
          >
        </details>
      </li>
    </ol>
  </section>
</template>
