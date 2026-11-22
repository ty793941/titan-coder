<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import { X, ArrowRight, FolderPlus, ListPlus } from "lucide-vue-next";
import { api, errorMessage } from "../api";
import type { Priority } from "../types";
const props = defineProps<{ kind: "project" | "task"; projectId: string }>();
const emit = defineEmits<{
  close: [];
  created: [id: string, kind: "project" | "task"];
}>();
const dialog = ref<HTMLDialogElement>();
const title = ref("");
const goal = ref("");
const criteria = ref("");
const priority = ref<Priority>("medium");
const busy = ref(false);
const error = ref("");
onMounted(async () => {
  dialog.value?.showModal();
  await nextTick();
  dialog.value?.querySelector("input")?.focus();
});
async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (props.kind === "project") {
      const result = await api.createProject(
        title.value.trim(),
        goal.value.trim(),
      );
      emit("created", result.id, "project");
    } else {
      const acceptanceCriteria = criteria.value
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
      if (!acceptanceCriteria.length) {
        error.value = "请至少填写一项验收标准，每行一项。";
        return;
      }
      const result = await api.createTask(props.projectId, {
        title: title.value.trim(),
        goal: goal.value.trim(),
        acceptanceCriteria,
        priority: priority.value,
      });
      emit("created", result.id, "task");
    }
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <dialog
    ref="dialog"
    class="create-dialog"
    aria-labelledby="create-title"
    @cancel.prevent="!busy && emit('close')"
    @click="(event) => event.target === dialog && !busy && emit('close')"
  >
    <div class="dialog-heading">
      <div class="icon-tile">
        <FolderPlus v-if="kind === 'project'" :size="21" /><ListPlus
          v-else
          :size="21"
        />
      </div>
      <button
        class="icon-button"
        aria-label="关闭"
        :disabled="busy"
        @click="emit('close')"
      >
        <X :size="20" />
      </button>
    </div>
    <div class="eyebrow">
      {{ kind === "project" ? "NEW PROJECT" : "NEW ACCEPTANCE TASK" }}
    </div>
    <h2 id="create-title">
      {{ kind === "project" ? "创建一个项目" : "定义你的验收任务" }}
    </h2>
    <p class="muted">
      {{
        kind === "project"
          ? "将目标、任务与执行证据放在一起。"
          : "从明确的目标开始，逐阶段审阅后再执行。"
      }}
    </p>
    <form @submit.prevent="submit">
      <label for="create-name">{{
        kind === "project" ? "项目名称" : "任务名称"
      }}</label
      ><input
        id="create-name"
        v-model="title"
        required
        maxlength="120"
        :disabled="busy"
        placeholder="一个简洁、可识别的名称"
      /><label for="create-goal">目标</label
      ><textarea
        id="create-goal"
        v-model="goal"
        required
        maxlength="2000"
        rows="3"
        :disabled="busy"
        placeholder="描述希望实现的结果…"
      />
      <template v-if="kind === 'task'"
        ><label for="create-criteria"
          >验收标准 <span class="muted">每行一项</span></label
        ><textarea
          id="create-criteria"
          v-model="criteria"
          required
          rows="3"
          maxlength="10000"
          :disabled="busy"
          placeholder="例如：在授权工作区生成 acceptance.md，并记录 SHA-256"
        /><label for="create-priority">优先级</label
        ><select id="create-priority" v-model="priority" :disabled="busy">
          <option value="low">低</option>
          <option value="medium">普通</option>
          <option value="high">高</option>
          <option value="critical">紧急</option>
        </select></template
      >
      <p v-if="error" role="alert" class="inline-error">{{ error }}</p>
      <div class="dialog-actions">
        <button
          class="button"
          type="button"
          :disabled="busy"
          @click="emit('close')"
        >
          取消</button
        ><button
          type="submit"
          class="button primary"
          :disabled="busy || !title.trim() || !goal.trim()"
        >
          {{ busy ? "创建中…" : kind === "project" ? "创建项目" : "创建任务"
          }}<ArrowRight :size="15" />
        </button>
      </div>
    </form>
  </dialog>
</template>
