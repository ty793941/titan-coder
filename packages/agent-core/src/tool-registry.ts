import { DomainError } from '@titan/contracts';
import { createHash } from 'node:crypto';
import type { HookRunner } from './hook-runner.js';
import type { PermissionEngine } from './permission-engine.js';
import type { SuccessfulTool, ToolManifest, ToolRequest, ToolResult } from './types.js';

type ToolRegistryOptions = {
  permission: PermissionEngine;
  hooks: HookRunner;
  onAudit?: (result: ToolResult) => void | Promise<void>;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

export function hashToolInput(input: unknown): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolManifest>();
  private readonly results = new Map<string, ToolResult>();

  constructor(private readonly options: ToolRegistryOptions) {}

  register(manifest: ToolManifest): void {
    if (this.tools.has(manifest.name)) throw new Error(`tool already registered: ${manifest.name}`);
    this.tools.set(manifest.name, manifest);
  }

  async execute(request: ToolRequest): Promise<ToolResult> {
    const inputHash = hashToolInput(request.input);
    const replay = this.results.get(request.toolUseId);
    if (replay) {
      if (replay.name !== request.name || replay.inputHash !== inputHash) throw new DomainError('TOOL_INPUT_INVALID', `tool ${request.toolUseId} input changed during replay`);
      return { ...replay, replayed: true };
    }
    const manifest = this.tools.get(request.name);
    if (!manifest) throw new DomainError('TOOL_INPUT_INVALID', `tool ${request.name} is not registered`);
    if (request.context.allowedTools && !request.context.allowedTools.includes(request.name)) {
      throw new DomainError('PERMISSION_DENIED', `tool ${request.name} is not allowed for this run`);
    }
    const parsed = manifest.input.safeParse(request.input);
    if (!parsed.success) throw new DomainError('TOOL_INPUT_INVALID', `input for ${request.name} is invalid`, { issues: parsed.error.issues });
    await this.options.permission.requireExecution({
      action: request.name,
      resource: request.context.runId,
      ...(request.context.approvalToken ? { approvalToken: request.context.approvalToken } : {}),
    });
    const before = await this.options.hooks.run('before', { toolName: request.name, runId: request.context.runId, input: parsed.data });
    if (before === 'deny') throw new DomainError('TOOL_BLOCKED_BY_HOOK', `pre-tool hook blocked ${request.name}`);
    let output: unknown;
    try {
      output = await manifest.execute(parsed.data, request.context);
    } catch (error) {
      throw new DomainError('TOOL_EXECUTION_FAILED', `tool ${request.name} failed`, { cause: String(error) });
    }
    const result: ToolResult = { toolUseId: request.toolUseId, name: request.name, inputHash, output, replayed: false };
    let after: 'allow' | 'deny';
    try {
      after = await this.options.hooks.run('after', { toolName: request.name, runId: request.context.runId, input: parsed.data, output });
    } catch (error) {
      const uncertain = { ...result, uncertain: true };
      this.results.set(request.toolUseId, uncertain);
      await this.options.onAudit?.(uncertain);
      throw error;
    }
    if (after === 'deny') {
      const uncertain = { ...result, uncertain: true };
      this.results.set(request.toolUseId, uncertain);
      await this.options.onAudit?.(uncertain);
      throw new DomainError('TOOL_BLOCKED_BY_HOOK', `post-tool hook blocked ${request.name}`);
    }
    this.results.set(request.toolUseId, result);
    await this.options.onAudit?.(result);
    return result;
  }

  hydrate(results: SuccessfulTool[]): void {
    for (const result of results) this.results.set(result.id, { toolUseId: result.id, name: result.name, inputHash: result.inputHash, output: result.output, replayed: false });
  }

  getSuccessfulResults(): SuccessfulTool[] {
    return [...this.results.values()].filter(result => !result.uncertain).map(result => ({ id: result.toolUseId, name: result.name, inputHash: result.inputHash, output: result.output }));
  }
}
