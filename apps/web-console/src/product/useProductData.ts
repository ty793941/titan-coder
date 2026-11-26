import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api";
import type { Artifact, ConsoleState, LocalStatus } from "../types";
import { buildDecisions } from "./decisions";
import type { ProductDecision } from "./types";
import { productErrorMessage } from "./errors";

export type ProductDataClient = Pick<
  typeof api,
  "state" | "localStatus" | "artifacts"
>;

export interface ProductDataSnapshot {
  state: ConsoleState;
  local: LocalStatus | null;
  artifactsByTask: Map<string, Artifact[]>;
  errors: string[];
  lastSync: string;
}

function abortError() {
  return new DOMException("请求已取消", "AbortError");
}

export async function loadProductData(
  client: ProductDataClient,
  signal?: AbortSignal,
): Promise<ProductDataSnapshot> {
  if (signal?.aborted) throw abortError();
  const [stateResult, localResult] = await Promise.allSettled([
    client.state(signal),
    client.localStatus(signal),
  ]);
  if (signal?.aborted) throw abortError();
  if (stateResult.status === "rejected") {
    if (
      stateResult.reason instanceof Error &&
      stateResult.reason.name === "AbortError"
    )
      throw stateResult.reason;
    throw stateResult.reason;
  }
  const errors: string[] = [];
  const local =
    localResult.status === "fulfilled"
      ? localResult.value
      : (errors.push(productErrorMessage(localResult.reason)), null);
  const artifactsByTask = new Map<string, Artifact[]>();
  const artifactResults = await Promise.allSettled(
    stateResult.value.tasks.map((task) => client.artifacts(task.id, signal)),
  );
  if (signal?.aborted) throw abortError();
  stateResult.value.tasks.forEach((task, index) => {
    const result = artifactResults[index]!;
    if (result.status === "fulfilled")
      artifactsByTask.set(task.id, result.value);
    else {
      artifactsByTask.set(task.id, []);
      errors.push(productErrorMessage(result.reason));
    }
  });
  return {
    state: stateResult.value,
    local,
    artifactsByTask,
    errors,
    lastSync: new Date().toISOString(),
  };
}

export function useProductData() {
  const state = ref<ConsoleState>({
    projects: [],
    tasks: [],
    sessions: [],
    runs: [],
    daemons: [],
  });
  const local = ref<LocalStatus | null>(null);
  const artifactsByTask = ref(new Map<string, Artifact[]>());
  const loading = ref(true);
  const refreshing = ref(false);
  const error = ref("");
  const partialErrors = ref<string[]>([]);
  const lastSync = ref("");
  let controller: AbortController | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  const projects = computed(() => state.value.projects);
  const decisions = computed<ProductDecision[]>(() =>
    buildDecisions({
      projects: state.value.projects,
      tasks: state.value.tasks,
      artifactsByTask: artifactsByTask.value,
      sessions: state.value.sessions,
      runs: state.value.runs,
    }),
  );

  async function refresh() {
    if (refreshing.value) return;
    controller?.abort();
    controller = new AbortController();
    const active = controller;
    refreshing.value = true;
    error.value = "";
    try {
      const snapshot = await loadProductData(api, active.signal);
      if (active.signal.aborted) return;
      state.value = snapshot.state;
      local.value = snapshot.local;
      artifactsByTask.value = snapshot.artifactsByTask;
      partialErrors.value = snapshot.errors;
      lastSync.value = snapshot.lastSync;
    } catch (caught) {
      if (!active.signal.aborted) error.value = productErrorMessage(caught);
    } finally {
      if (!active.signal.aborted) {
        loading.value = false;
        refreshing.value = false;
      }
    }
  }

  onMounted(() => {
    void refresh();
    interval = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
  });
  onBeforeUnmount(() => {
    clearInterval(interval);
    controller?.abort();
  });

  return {
    state,
    local,
    projects,
    artifactsByTask,
    decisions,
    loading,
    refreshing,
    error,
    partialErrors,
    lastSync,
    refresh,
  };
}
