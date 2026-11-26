<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { api } from "../../api";
import { productErrorMessage } from "../../product/errors";
const props = defineProps<{ artifactId: string; checksum?: string }>();
const emit = defineEmits<{ verified: [value: boolean] }>();
const content = ref("");
const error = ref("");
const loading = ref(true);
const retry = ref(0);
let controller: AbortController | undefined;
watch(
  () => [props.artifactId, props.checksum, retry.value],
  async () => {
    controller?.abort();
    const active = (controller = new AbortController());
    content.value = "";
    error.value = "";
    loading.value = true;
    emit("verified", false);
    try {
      const result = await api.content(props.artifactId, active.signal);
      if (active.signal.aborted) return;
      if (!props.checksum || result.checksum !== props.checksum)
        error.value = "版本校验不一致，请刷新项目资料后重新审阅。";
      else {
        content.value = result.content;
        emit("verified", true);
      }
    } catch (caught) {
      if (!active.signal.aborted) error.value = productErrorMessage(caught);
    } finally {
      if (!active.signal.aborted) loading.value = false;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <section class="product-document" aria-label="交付物正文">
    <p v-if="loading" role="status">正在读取此版本正文…</p>
    <div v-else-if="error" role="alert">
      <p>{{ error }}</p>
      <button class="product-secondary-action" @click="retry++">
        重新读取
      </button>
    </div>
    <pre v-else>{{ content || "此版本没有正文。" }}</pre>
  </section>
</template>
