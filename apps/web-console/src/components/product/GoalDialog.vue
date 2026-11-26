<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ArrowRight, X } from "lucide-vue-next";
import { api, newRequestKey } from "../../api";
import { productErrorMessage } from "../../product/errors";
const props = defineProps<{ projectId?: string }>();
const emit = defineEmits<{ close: []; created: [id: string] }>();
const dialog = ref<HTMLDialogElement>();
const title = ref("");
const goal = ref("");
const criteria = ref("");
const busy = ref(false);
const error = ref("");
const requestKey = newRequestKey();
onMounted(() => dialog.value?.showModal());
async function submit() {
  if (busy.value || !title.value.trim() || !goal.value.trim()) return;
  const acceptanceCriteria = criteria.value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  if (props.projectId && !acceptanceCriteria.length) {
    error.value = "请至少填写一项成功标准，每行一项。";
    return;
  }
  error.value = "";
  busy.value = true;
  try {
    const result = props.projectId
      ? await api.createTask(
          props.projectId,
          {
            title: title.value.trim(),
            goal: goal.value.trim(),
            acceptanceCriteria,
            priority: "medium",
          },
          requestKey,
        )
      : await api.createProject(
          title.value.trim(),
          goal.value.trim(),
          requestKey,
        );
    emit("created", result.id);
  } catch (caught) {
    error.value = productErrorMessage(caught);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <dialog
    ref="dialog"
    class="product-goal-dialog"
    aria-labelledby="goal-title"
    @cancel.prevent="!busy && emit('close')"
  >
    <header>
      <span class="product-kicker">{{
        projectId ? "新的工作目标" : "从一个目标开始"
      }}</span
      ><button
        class="product-icon-button"
        :disabled="busy"
        aria-label="关闭创建窗口"
        @click="emit('close')"
      >
        <X :size="18" />
      </button>
    </header>
    <h2 id="goal-title">
      {{ projectId ? "下一步，希望实现什么？" : "开始一个新项目。" }}
    </h2>
    <p>先定义希望达成的结果，再逐步确认方案与交付。</p>
    <form @submit.prevent="submit">
      <label for="goal-name">{{
        projectId ? "工作目标名称" : "项目名称"
      }}</label
      ><input
        id="goal-name"
        v-model="title"
        required
        maxlength="120"
        :disabled="busy"
        autofocus
        placeholder="例如：让客户能在线完成退款"
      />
      <label for="goal-outcome">希望达成的结果</label
      ><textarea
        id="goal-outcome"
        v-model="goal"
        required
        maxlength="2000"
        rows="4"
        :disabled="busy"
        placeholder="谁会使用它？完成后会带来什么改变？"
      />
      <template v-if="projectId"
        ><label for="goal-success">成功标准 <span>每行一项</span></label
        ><textarea
          id="goal-success"
          v-model="criteria"
          required
          maxlength="10000"
          rows="3"
          :disabled="busy"
          placeholder="例如：客户可查看退款进度，且能收到处理结果"
        />
      </template>
      <p v-if="error" role="alert" class="product-detail-error">{{ error }}</p>
      <footer>
        <button
          type="button"
          class="product-secondary-action"
          :disabled="busy"
          @click="emit('close')"
        >
          取消</button
        ><button class="product-primary-action" :disabled="busy">
          {{ busy ? "保存中…" : projectId ? "建立工作目标" : "创建项目"
          }}<ArrowRight :size="15" />
        </button>
      </footer>
    </form>
  </dialog>
</template>
