import { DomainError } from '@titan/contracts';
import type { HookRunner } from './hook-runner.js';
import type { PermissionEngine } from './permission-engine.js';
import type { ToolManifest, ToolRequest, ToolResult } from './types.js';

type ToolRegistryOptions = {
  permission: PermissionEngine;
  hooks: HookRunner;
  onAudit?: (result: ToolResult) => void;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolManifest>();
  private readonly results = new Map<string, ToolResult>();

  constructor(private readonly options: ToolRegistryOptions) {}

  register(manifest: ToolManifest): void {
    if (this.tools.has(manifest.name)) throw new Error(`tool already registered: ${manifest.name}`);
    this.tools.set(manifest.name, manifest);
  }

  async execute(request: ToolRequest): Promise<ToolResult> {
    const replay = this.results.get(request.toolUseId);
    if (replay) return { ...replay, replayed: true };
    const manifest = this.tools.get(request.name);
    if (!manifest) throw new DomainError('TOOL_INPUT_INVALID', `tool ${request.name} is not registered`);
    const parsed = manifest.input.safeParse(request.input);
    if (!parsed.success) throw new DomainError('TOOL_INPUT_INVALID', `input for ${request.name} is invalid`, { issues: parsed.error.issues });
    this.options.permission.requireExecution({
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
    const after = await this.options.hooks.run('after', { toolName: request.name, runId: request.context.runId, input: parsed.data, output });
    if (after === 'deny') throw new DomainError('TOOL_BLOCKED_BY_HOOK', `post-tool hook blocked ${request.name}`);
    const result: ToolResult = { toolUseId: request.toolUseId, name: request.name, output, replayed: false };
    this.results.set(request.toolUseId, result);
    this.options.onAudit?.(result);
    return result;
  }
}
