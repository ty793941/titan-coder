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
  let refreshPromise: Promise<boolean> | undefined;
  let refreshAgain = false;
  let disposed = false;

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

  async function refreshOnce(): Promise<boolean> {
    controller?.abort();
    controller = new AbortController();
    const active = controller;
    error.value = "";
    try {
      const snapshot = await loadProductData(api, active.signal);
      if (active.signal.aborted) return false;
      state.value = snapshot.state;
      local.value = snapshot.local;
      artifactsByTask.value = snapshot.artifactsByTask;
      partialErrors.value = snapshot.errors;
      lastSync.value = snapshot.lastSync;
      return true;
    } catch (caught) {
      if (!active.signal.aborted) error.value = productErrorMessage(caught);
      return false;
    } finally {
      if (!active.signal.aborted) {
        loading.value = false;
      }
    }
  }
  function refresh(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (refreshPromise) {
      refreshAgain = true;
      return refreshPromise;
    }
    refreshing.value = true;
    refreshPromise = (async () => {
      let succeeded = false;
      do {
        refreshAgain = false;
        succeeded = await refreshOnce();
      } while (refreshAgain && !disposed);
      return succeeded && !disposed;
    })().finally(() => {
      refreshPromise = undefined;
      refreshing.value = false;
    });
    return refreshPromise;
  }

  onMounted(() => {
    void refresh();
    interval = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
  });
  onBeforeUnmount(() => {
    disposed = true;
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
