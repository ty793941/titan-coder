import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, errorMessage } from "./api";
import type { Artifact, ConsoleState, LocalStatus } from "./types";

export function useConsole() {
  const state = ref<ConsoleState>({
    projects: [],
    tasks: [],
    sessions: [],
    runs: [],
    daemons: [],
  });
  const local = ref<LocalStatus | null>(null);
  const projectId = ref("");
  const taskId = ref("");
  const artifacts = ref<Artifact[]>([]);
  const loading = ref(true);
  const refreshing = ref(false);
  const stateError = ref("");
  const localError = ref("");
  const artifactsError = ref("");
  const lastSync = ref("");
  const artifactsLoading = ref(false);
  const project = computed(() =>
    state.value.projects.find((item) => item.id === projectId.value),
  );
  const tasks = computed(() =>
    state.value.tasks.filter((item) => item.projectId === projectId.value),
  );
  const task = computed(() =>
    tasks.value.find((item) => item.id === taskId.value),
  );
  let stateController: AbortController | undefined;
  let artifactController: AbortController | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  watch(
    () => state.value.projects,
    (projects) => {
      if (!projects.some((item) => item.id === projectId.value))
        projectId.value = projects[0]?.id || "";
    },
  );
  watch(tasks, (values) => {
    if (!values.some((item) => item.id === taskId.value))
      taskId.value = values[0]?.id || "";
  });

  async function loadArtifacts() {
    artifactController?.abort();
    artifactController = new AbortController();
    const active = artifactController;
    const target = taskId.value;
    artifactsError.value = "";
    if (!target) {
      artifacts.value = [];
      artifactsLoading.value = false;
      return;
    }
    artifactsLoading.value = true;
    try {
      const result = await api.artifacts(target, active.signal);
      if (!active.signal.aborted && taskId.value === target)
        artifacts.value = result;
    } catch (error) {
      if (!active.signal.aborted) artifactsError.value = errorMessage(error);
    } finally {
      if (!active.signal.aborted) artifactsLoading.value = false;
    }
  }
  watch(taskId, () => {
    artifacts.value = [];
    void loadArtifacts();
  });
  async function refresh() {
    if (refreshing.value) return;
    refreshing.value = true;
    stateController = new AbortController();
    const active = stateController;
    const results = await Promise.allSettled([
      api.state(active.signal),
      api.localStatus(active.signal),
    ]);
    if (active.signal.aborted) return;
    const snapshot = results[0];
    const localResult = results[1];
    if (snapshot.status === "fulfilled") {
      const value = snapshot.value;
      if (
        [
          value.projects,
          value.tasks,
          value.sessions,
          value.runs,
          value.daemons,
        ].every(Array.isArray)
      ) {
        state.value = value;
        stateError.value = "";
        lastSync.value = new Date().toISOString();
      } else stateError.value = "控制面返回的数据结构不完整，请检查网关版本。";
    } else stateError.value = errorMessage(snapshot.reason);
    if (localResult.status === "fulfilled") {
      local.value = localResult.value;
      localError.value = "";
    } else {
      local.value = null;
      localError.value = errorMessage(localResult.reason);
    }
    loading.value = false;
    refreshing.value = false;
    await loadArtifacts();
  }
  onMounted(() => {
    void refresh();
    interval = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
  });
  onBeforeUnmount(() => {
    clearInterval(interval);
    stateController?.abort();
    artifactController?.abort();
  });
  return {
    state,
    local,
    projectId,
    taskId,
    project,
    tasks,
    task,
    artifacts,
    loading,
    refreshing,
    stateError,
    localError,
    artifactsError,
    artifactsLoading,
    lastSync,
    refresh,
  };
}
