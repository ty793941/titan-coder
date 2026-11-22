import { DomainError } from '@titan/contracts';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, resolve, sep } from 'node:path';
import type { HookRunner } from './hook-runner.js';
import type { PermissionEngine } from './permission-engine.js';
import type { SuccessfulTool, ToolAuditEvent, ToolManifest, ToolRequest, ToolResult } from './types.js';
import type { ToolLedger } from './tool-ledger.js';

type ToolRegistryOptions = {
  permission: PermissionEngine;
  hooks: HookRunner;
  ledger?: ToolLedger;
  onAudit?: (event: ToolAuditEvent) => void | Promise<void>;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

export function hashToolInput(input: unknown): string {
  return createHash('sha256').update(stableJson(input) ?? 'undefined').digest('hex');
}

function canonicalKey(name: string, inputHash: string): string { return `${name}\0${inputHash}`; }

async function verifyArtifact(output: unknown, workspacePath?: string): Promise<boolean> {
  if (!output || typeof output !== 'object') return false;
  const value = output as { kind?: unknown; uri?: unknown; checksum?: unknown };
  if (value.kind !== 'artifact' || typeof value.uri !== 'string' || typeof value.checksum !== 'string' || !value.checksum.startsWith('sha256:')) return false;
  try {
    const target = fileURLToPath(value.uri);
    if (workspacePath) {
      const workspace = await realpath(workspacePath);
      const realTarget = await realpath(target);
      const child = relative(resolve(workspace), realTarget);
      if (child.startsWith(`..${sep}`) || child === '..') return false;
    }
    const actual = createHash('sha256').update(await readFile(target)).digest('hex');
    return `sha256:${actual}` === value.checksum;
  } catch { return false; }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolManifest>();
  private readonly results = new Map<string, ToolResult>();
  private readonly canonicalResults = new Map<string, ToolResult>();

  constructor(private readonly options: ToolRegistryOptions) {}

  register(manifest: ToolManifest): void {
    if (this.tools.has(manifest.name)) throw new Error(`tool already registered: ${manifest.name}`);
    this.tools.set(manifest.name, manifest);
  }

  async execute(request: ToolRequest): Promise<ToolResult> {
    const inputHash = hashToolInput(request.input);
    const manifest = this.tools.get(request.name);
    if (!manifest) throw new DomainError('TOOL_INPUT_INVALID', `tool ${request.name} is not registered`);
    if (request.context.allowedTools && !request.context.allowedTools.includes(request.name)) throw new DomainError('PERMISSION_DENIED', `tool ${request.name} is not allowed for this run`);
    const parsed = manifest.input.safeParse(request.input);
    if (!parsed.success) throw new DomainError('TOOL_INPUT_INVALID', `input for ${request.name} is invalid`, { issues: parsed.error.issues });
    await this.options.permission.requireExecution({
      action: request.name,
      resource: request.context.runId,
      ...(request.context.approvalToken ? { approvalToken: request.context.approvalToken } : {}),
    });
    const replay = this.results.get(request.toolUseId);
    if (replay) {
      if (replay.name !== request.name || replay.inputHash !== inputHash) throw new DomainError('TOOL_INPUT_INVALID', `tool ${request.toolUseId} input changed during replay`);
      if (replay.uncertain) throw new DomainError('TOOL_EXECUTION_FAILED', `TOOL_EXECUTION_UNCERTAIN: tool ${request.toolUseId} cannot be replayed`);
      return { ...replay, replayed: true };
    }
    await this.options.onAudit?.({ source: 'tool', status: 'started', toolName: request.name, toolCallId: request.toolUseId, runId: request.context.runId, inputHash });
    const hookContext = {
      toolName: request.name,
      toolCallId: request.toolUseId,
      runId: request.context.runId,
      input: parsed.data,
      ...(request.context.workspacePath ? { workspacePath: request.context.workspacePath } : {}),
      ...(request.context.secretValues ? { secretValues: request.context.secretValues } : {}),
    };
    const before = await this.options.hooks.run('before', hookContext);
    if (before === 'deny') {
      await this.options.onAudit?.({ source: 'tool', status: 'blocked', toolName: request.name, toolCallId: request.toolUseId, runId: request.context.runId, inputHash, reason: 'pre-tool hook blocked' });
      throw new DomainError('TOOL_BLOCKED_BY_HOOK', `pre-tool hook blocked ${request.name}`);
    }
    const canonical = canonicalKey(request.name, inputHash);
    const volatile = ['workspace.read', 'workspace.search', 'command.test'].includes(request.name);
    const ledger = volatile ? undefined : this.options.ledger;
    let canonicalReplay = volatile ? undefined : this.canonicalResults.get(canonical);
    if (!canonicalReplay && ledger) {
      const ledgerReplay = await ledger.begin({ toolCallId: request.toolUseId, toolName: request.name, inputHash });
      if (ledgerReplay) canonicalReplay = { toolUseId: request.toolUseId, name: request.name, inputHash, output: ledgerReplay.output, replayed: false };
    }
    if (canonicalReplay && request.name === 'artifact.write' && !(await verifyArtifact(canonicalReplay.output, request.context.workspacePath))) {
      await ledger?.discard({ toolName: request.name, inputHash });
      this.canonicalResults.delete(canonical);
      canonicalReplay = undefined;
      if (ledger) await ledger.begin({ toolCallId: request.toolUseId, toolName: request.name, inputHash });
    }
    if (canonicalReplay) {
      if (canonicalReplay.uncertain) throw new DomainError('TOOL_EXECUTION_FAILED', `TOOL_EXECUTION_UNCERTAIN: tool ${request.name} cannot be replayed`);
      const replayed = { toolUseId: request.toolUseId, name: request.name, inputHash, output: canonicalReplay.output, replayed: true };
      this.results.set(request.toolUseId, replayed);
      this.canonicalResults.set(canonical, replayed);
      await this.options.onAudit?.({ source: 'tool', status: 'replayed', toolName: request.name, toolCallId: request.toolUseId, runId: request.context.runId, inputHash });
      return replayed;
    }
    let output: unknown;
    try {
      output = await manifest.execute(parsed.data, request.context);
    } catch (error) {
      await ledger?.uncertain({ toolCallId: request.toolUseId, toolName: request.name, inputHash }).catch(() => undefined);
      await this.options.onAudit?.({ source: 'tool', status: 'uncertain', toolName: request.name, toolCallId: request.toolUseId, runId: request.context.runId, inputHash, reason: String(error) });
      throw new DomainError('TOOL_EXECUTION_FAILED', `tool ${request.name} failed`, { cause: String(error) });
    }
    const result: ToolResult = { toolUseId: request.toolUseId, name: request.name, inputHash, output, replayed: false };
    let after: 'allow' | 'deny';
    try {
      after = await this.options.hooks.run('after', { ...hookContext, output });
    } catch (error) {
      const uncertain = { ...result, uncertain: true };
      this.results.set(request.toolUseId, uncertain);
      await ledger?.uncertain({ toolCallId: request.toolUseId, toolName: request.name, inputHash, output }).catch(() => undefined);
      await this.options.onAudit?.({ source: 'tool', status: 'uncertain', toolName: request.name, toolCallId: request.toolUseId, runId: request.context.runId, inputHash, reason: String(error) });
      throw error;
    }
    if (after === 'deny') {
      const uncertain = { ...result, uncertain: true };
      this.results.set(request.toolUseId, uncertain);
      await ledger?.uncertain({ toolCallId: request.toolUseId, toolName: request.name, inputHash, output }).catch(() => undefined);
      await this.options.onAudit?.({ source: 'tool', status: 'uncertain', toolName: request.name, toolCallId: request.toolUseId, runId: request.context.runId, inputHash, reason: 'post-tool hook blocked' });
      throw new DomainError('TOOL_BLOCKED_BY_HOOK', `post-tool hook blocked ${request.name}`);
    }
    try {
      await ledger?.success({ toolCallId: request.toolUseId, toolName: request.name, inputHash, output });
    } catch (error) {
      const uncertain = { ...result, uncertain: true };
      this.results.set(request.toolUseId, uncertain);
      await ledger?.uncertain({ toolCallId: request.toolUseId, toolName: request.name, inputHash, output }).catch(() => undefined);
      await this.options.onAudit?.({ source: 'tool', status: 'uncertain', toolName: request.name, toolCallId: request.toolUseId, runId: request.context.runId, inputHash, reason: String(error) });
      throw error;
    }
    this.results.set(request.toolUseId, result);
    this.canonicalResults.set(canonical, result);
    await this.options.onAudit?.({ source: 'tool', status: 'success', toolName: request.name, toolCallId: request.toolUseId, runId: request.context.runId, inputHash });
    return result;
  }

  hydrate(results: SuccessfulTool[]): void {
    for (const result of results) {
      const hydrated = { toolUseId: result.id, name: result.name, inputHash: result.inputHash, output: result.output, replayed: false };
      this.results.set(result.id, hydrated);
      this.canonicalResults.set(canonicalKey(result.name, result.inputHash), hydrated);
    }
  }

  async hydrateVerified(results: SuccessfulTool[], _workspacePath?: string): Promise<SuccessfulTool[]> {
    const valid: SuccessfulTool[] = [];
    for (const result of results) {
      if (result.name === 'artifact.write' && !(await verifyArtifact(result.output, _workspacePath))) continue;
      valid.push(result);
    }
    this.hydrate(valid);
    return valid;
  }

  getSuccessfulResults(): SuccessfulTool[] {
    return [...this.results.values()].filter(result => !result.uncertain).map(result => ({ id: result.toolUseId, name: result.name, inputHash: result.inputHash, output: result.output }));
  }
}
