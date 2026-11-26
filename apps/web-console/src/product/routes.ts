export type ProductRoute =
  | { name: "inbox" }
  | { name: "projects" }
  | { name: "project"; projectId: string }
  | { name: "decision"; decisionId: string }
  | { name: "deliveries" }
  | { name: "activity" }
  | { name: "acceptance"; runId?: string };

export function parseProductRoute(hash: string): ProductRoute {
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
  const project = /^\/projects\/([^/?#]+)$/.exec(value);
  if (project)
    return { name: "project", projectId: decodeURIComponent(project[1]!) };
  const decision = /^\/decisions\/([^/?#]+)$/.exec(value);
  if (decision)
    return { name: "decision", decisionId: decodeURIComponent(decision[1]!) };
  return { name: "inbox" };
}

export function productRoute(route: ProductRoute): string {
  if (route.name === "inbox") return "#/";
  if (route.name === "projects") return "#/projects";
  if (route.name === "acceptance")
    return route.runId ? `#/acceptance?run=${encodeURIComponent(route.runId)}` : "#/acceptance";
  if (route.name === "project")
    return `#/projects/${encodeURIComponent(route.projectId)}`;
  if (route.name === "decision")
    return `#/decisions/${encodeURIComponent(route.decisionId)}`;
  return `#/${route.name}`;
}
