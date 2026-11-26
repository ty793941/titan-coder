export type ProductRoute =
  | { name: "inbox" }
  | { name: "projects" }
  | { name: "task"; taskId: string }
  | { name: "execution"; runId: string }
  | { name: "launch"; taskId: string }
  | { name: "settings" }
  | { name: "project"; projectId: string }
  | { name: "decision"; decisionId: string }
  | { name: "deliveries" }
  | { name: "activity" }
  | { name: "acceptance"; runId?: string };

export function parseProductRoute(hash: string): ProductRoute {
  try {
    const value = hash.replace(/^#/, "");
    const acceptance = /^\/acceptance(?:\?run=([^&#]+))?$/.exec(value);
    if (acceptance)
      return {
        name: "acceptance",
        ...(acceptance[1] ? { runId: decodeURIComponent(acceptance[1]) } : {}),
      };
    if (value === "/projects") return { name: "projects" };
    if (value === "/deliveries") return { name: "deliveries" };
    if (value === "/activity") return { name: "activity" };
    if (value === "/settings") return { name: "settings" };
    const task = /^\/tasks\/([^/?#]+)$/.exec(value);
    if (task) return { name: "task", taskId: decodeURIComponent(task[1]!) };
    const launch = /^\/tasks\/([^/?#]+)\/execution$/.exec(value);
    if (launch)
      return { name: "launch", taskId: decodeURIComponent(launch[1]!) };
    const execution = /^\/executions\/([^/?#]+)$/.exec(value);
    if (execution)
      return { name: "execution", runId: decodeURIComponent(execution[1]!) };
    const project = /^\/projects\/([^/?#]+)$/.exec(value);
    if (project)
      return { name: "project", projectId: decodeURIComponent(project[1]!) };
    const decision = /^\/decisions\/([^/?#]+)$/.exec(value);
    if (decision)
      return { name: "decision", decisionId: decodeURIComponent(decision[1]!) };
    return { name: "inbox" };
  } catch {
    return { name: "inbox" };
  }
}

export function productRoute(route: ProductRoute): string {
  if (route.name === "inbox") return "#/";
  if (route.name === "projects") return "#/projects";
  if (route.name === "task")
    return `#/tasks/${encodeURIComponent(route.taskId)}`;
  if (route.name === "execution")
    return `#/executions/${encodeURIComponent(route.runId)}`;
  if (route.name === "launch")
    return `#/tasks/${encodeURIComponent(route.taskId)}/execution`;
  if (route.name === "acceptance")
    return route.runId
      ? `#/acceptance?run=${encodeURIComponent(route.runId)}`
      : "#/acceptance";
  if (route.name === "project")
    return `#/projects/${encodeURIComponent(route.projectId)}`;
  if (route.name === "decision")
    return `#/decisions/${encodeURIComponent(route.decisionId)}`;
  return `#/${route.name}`;
}
