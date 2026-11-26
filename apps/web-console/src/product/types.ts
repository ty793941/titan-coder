import type { Artifact, Project, Run, Session, Task } from "../types";

export type DecisionType =
  | "review_artifact"
  | "advance_stage"
  | "execution_attention";
export type DecisionPriority = "critical" | "high" | "medium" | "low";

export interface ProductDecision {
  id: string;
  type: DecisionType;
  priority: DecisionPriority;
  projectId: string;
  taskId: string;
  title: string;
  summary: string;
  whyNow: string;
  recommendation: string;
  impact: string;
  actionLabel: string;
  artifactId?: string;
  runId?: string;
  createdAt: string;
}

export interface DecisionInput {
  projects: Project[];
  tasks: Task[];
  artifactsByTask: Map<string, Artifact[]>;
  sessions: Session[];
  runs: Run[];
}
