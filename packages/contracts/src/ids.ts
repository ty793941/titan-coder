export type ProjectId = string & { readonly __brand: 'ProjectId' };
export type TaskId = string & { readonly __brand: 'TaskId' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type RunId = string & { readonly __brand: 'RunId' };
export type ArtifactId = string & { readonly __brand: 'ArtifactId' };
export type EventId = string & { readonly __brand: 'EventId' };
export type DaemonId = string & { readonly __brand: 'DaemonId' };

export const asProjectId = (value: string): ProjectId => value as ProjectId;
export const asTaskId = (value: string): TaskId => value as TaskId;
export const asSessionId = (value: string): SessionId => value as SessionId;
export const asRunId = (value: string): RunId => value as RunId;
export const asArtifactId = (value: string): ArtifactId => value as ArtifactId;
export const asEventId = (value: string): EventId => value as EventId;
export const asDaemonId = (value: string): DaemonId => value as DaemonId;
