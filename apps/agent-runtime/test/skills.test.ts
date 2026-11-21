import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeSession, RuntimeAdapter, RuntimeEvent, RuntimeInput, RuntimeSessionConfig } from '@titan/agent-core';
import type { RunDispatch, RunProgress } from '@titan/daemon-protocol';
import { executeDispatch } from '../src/worker.js';
import { computeSkillDigest, loadSkillCatalog, loadSkillContext } from '../src/skills.js';

class ContextAdapter implements RuntimeAdapter {
  readonly goals: string[] = [];
  readonly configs: RuntimeSessionConfig[] = [];
  private readonly session: NativeSession = { id: 'skill-fixture', runtime: 'qwen' };
  private readonly requestTool: boolean;
  private toolSent = false;
  private toolResult = false;

  constructor(requestTool = false) {
    this.requestTool = requestTool;
  }

  async createSession(config: RuntimeSessionConfig): Promise<NativeSession> {
    this.configs.push(config);
    return this.session;
  }

  async *streamEvents(): AsyncIterable<RuntimeEvent> {
    if (this.requestTool && !this.toolSent) {
      this.toolSent = true;
      yield { type: 'tool.requested', payload: { id: 'read-context', name: 'workspace.read', arguments: { path: 'AGENTS.md' } } };
      return;
    }
    yield { type: 'session.completed' };
  }

  async sendInput(_session: NativeSession, input: RuntimeInput): Promise<void> {
    if (input.toolResults?.length) this.toolResult = true;
    else this.goals.push(input.text);
  }

  async pause(): Promise<{ id: string }> { return { id: 'checkpoint' }; }
  async resume(): Promise<void> {}
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(instructions = '只读项目 Skill 指令'): Promise<{ root: string; skillPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'titan-skills-'));
  roots.push(root);
  const skillPath = join(root, '.titan', 'skills', 'demo');
  await mkdir(skillPath, { recursive: true });
  await writeFile(join(skillPath, 'instructions.md'), instructions, 'utf8');
  return { root, skillPath };
}

async function writeLock(root: string, skillPath: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const sha256 = await computeSkillDigest(skillPath);
  await writeFile(join(root, '.titan', 'skills', 'skill-lock.json'), JSON.stringify({ entries: [{ id: 'demo.skill', version: '1.0.0', path: 'demo', sha256, tools: ['workspace.read'], ...overrides }] }), 'utf8');
}

function dispatch(root: string, localPolicy: Record<string, unknown> = {}, allowedTools = ['workspace.read']): RunDispatch {
  return {
    jobId: 'job-skill', runId: 'run-skill', sessionId: 'session-skill', taskId: 'task-skill', projectId: 'project-skill', goal: '完成 Skill 目标', planHash: 'plan-skill', claimToken: 'claim-skill',
    config: { daemonId: 'daemon-skill', runtime: 'qwen', credentialRef: 'runtime://skill-test', workspacePath: root, allowedTools, maxTurns: 1, timeoutMs: 5000, localPolicy } as RunDispatch['config'],
  };
}

describe('Local project Skill catalog', () => {
  it('returns an empty catalog when the lock file is absent', async () => {
    const { root } = await createWorkspace();
    await expect(loadSkillCatalog(root)).resolves.toEqual({ entries: [] });
  });

  it('loads a manifest-selected instruction file and exposes traceable context references', async () => {
    const { root, skillPath } = await createWorkspace('manifest instruction');
    await writeFile(join(skillPath, 'skill.json'), JSON.stringify({ entry: { instructions: 'guide.md' }, tools: ['workspace.write'] }), 'utf8');
    await writeFile(join(skillPath, 'guide.md'), 'manifest instruction', 'utf8');
    await writeLock(root, skillPath);
    await writeFile(join(root, 'AGENTS.md'), '项目必须保留测试证据', 'utf8');

    const context = await loadSkillContext({ workspacePath: root, allowedTools: ['workspace.read'], enabledSkillIds: ['demo.skill'] });
    expect(context).toMatchObject({ skills: [{ id: 'demo.skill', version: '1.0.0', references: ['workspace://.titan/skills/demo/guide.md'] }] });
    expect(context?.text).toContain('manifest instruction');
    expect(context?.text).toContain('项目必须保留测试证据');
    expect(context?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('rejects a digest mismatch after the locked skill is tampered with', async () => {
    const { root, skillPath } = await createWorkspace();
    await writeLock(root, skillPath);
    await writeFile(join(skillPath, 'instructions.md'), 'tampered', 'utf8');
    await expect(loadSkillCatalog(root)).rejects.toThrow(/digest|sha256|摘要/i);
  });

  it('rejects traversal and symlinked locked skill paths', async () => {
    const { root, skillPath } = await createWorkspace();
    await writeFile(join(root, '.titan', 'skills', 'skill-lock.json'), JSON.stringify({ entries: [{ id: 'escape', version: '1.0.0', path: '../outside', sha256: 'sha256:' + '0'.repeat(64), tools: [] }] }), 'utf8');
    await expect(loadSkillCatalog(root)).rejects.toThrow(/relative|escape|path/i);

    const outside = await mkdtemp(join(tmpdir(), 'titan-skill-outside-'));
    roots.push(outside);
    const linked = join(root, '.titan', 'skills', 'linked');
    await symlink(outside, linked);
    await writeFile(join(root, '.titan', 'skills', 'skill-lock.json'), JSON.stringify({ entries: [{ id: 'linked', version: '1.0.0', path: 'linked', sha256: 'sha256:' + '0'.repeat(64), tools: [] }] }), 'utf8');
    await expect(loadSkillCatalog(root)).rejects.toThrow(/symlink|symbolic|path/i);
    void skillPath;
  });

  it('rejects an instruction file larger than 64 KiB', async () => {
    const { root, skillPath } = await createWorkspace('x'.repeat(64 * 1024 + 1));
    await writeFile(join(root, '.titan', 'skills', 'skill-lock.json'), JSON.stringify({ entries: [{ id: 'demo.skill', version: '1.0.0', path: 'demo', sha256: 'sha256:' + '0'.repeat(64), tools: [] }] }), 'utf8');
    await expect(loadSkillCatalog(root)).rejects.toThrow(/64|large|size/i);
  });

  it('requires explicit activation and intersects locked tools with run tools', async () => {
    const { root, skillPath } = await createWorkspace();
    await writeLock(root, skillPath, { tools: ['workspace.write'] });
    await expect(loadSkillContext({ workspacePath: root, allowedTools: ['workspace.read'], enabledSkillIds: [] })).resolves.toBeUndefined();
    await expect(loadSkillContext({ workspacePath: root, allowedTools: ['workspace.read'], enabledSkillIds: ['demo.skill'] })).rejects.toThrow(/allowed|permission|tool/i);
  });

  it('rejects plaintext secrets in instructions and AGENTS.md', async () => {
    const secretSkill = await createWorkspace('secretKey = plaintext-value');
    await writeLock(secretSkill.root, secretSkill.skillPath);
    await expect(loadSkillCatalog(secretSkill.root)).rejects.toThrow(/secret|sensitive/i);

    const privateKeySkill = await createWorkspace('-----BEGIN PRIVATE KEY-----');
    await writeLock(privateKeySkill.root, privateKeySkill.skillPath);
    await expect(loadSkillCatalog(privateKeySkill.root)).rejects.toThrow(/secret|private|sensitive/i);

    const jsonSecretSkill = await createWorkspace('{"privateKey":"plaintext-value"}');
    await writeLock(jsonSecretSkill.root, jsonSecretSkill.skillPath);
    await expect(loadSkillCatalog(jsonSecretSkill.root)).rejects.toThrow(/secret|private|sensitive/i);

    const agentsSkill = await createWorkspace();
    await writeLock(agentsSkill.root, agentsSkill.skillPath);
    await writeFile(join(agentsSkill.root, 'AGENTS.md'), 'apiKey: plaintext-value', 'utf8');
    await expect(loadSkillContext({ workspacePath: agentsSkill.root, allowedTools: ['workspace.read'], enabledSkillIds: ['demo.skill'] })).rejects.toThrow(/secret|sensitive/i);
  });
});

describe('Worker Skill context integration', () => {
  it('appends a fixed trusted context block, emits only a digest reference, and keeps instructions out of progress output', async () => {
    const { root, skillPath } = await createWorkspace('DO NOT LOG THIS FULL INSTRUCTION');
    await writeLock(root, skillPath);
    await writeFile(join(root, 'AGENTS.md'), '规则 A\n规则 "B"\\C', 'utf8');
    const adapter = new ContextAdapter(true);
    const progress: RunProgress[] = [];
    const skillDispatch = dispatch(root, { enabledSkills: ['demo.skill'] });
    skillDispatch.config.maxTurns = 2;
    const result = await executeDispatch(skillDispatch, { adapterFactory: () => adapter, credentialResolver: async () => 'fixture-secret', sendProgress: event => progress.push(event) });

    expect(result.status).toBe('waiting_input');
    expect(adapter.goals[0]).toContain('完成 Skill 目标');
    expect(adapter.goals[0]).toContain('DO NOT LOG THIS FULL INSTRUCTION');
    const contextEvent = progress.find(event => event.type === 'output' && typeof event.payload.reference === 'string' && event.payload.reference.startsWith('context://sha256/'));
    expect(contextEvent).toBeDefined();
    expect(contextEvent?.payload.source).toBeUndefined();
    expect(contextEvent?.payload.text).toContain('demo.skill@1.0.0');
    expect(contextEvent?.payload.text).not.toContain('DO NOT LOG THIS FULL INSTRUCTION');
    const serializedProgress = progress.map(event => JSON.stringify(event)).join('\n');
    expect(serializedProgress).not.toContain('DO NOT LOG THIS FULL INSTRUCTION');
    expect(serializedProgress).not.toContain('规则 A');
    expect(progress.find(event => event.type === 'checkpoint')?.checkpoint?.messages.some(message => message.text.includes('trusted context snapshot'))).toBe(true);
    expect(JSON.stringify(result.checkpoint)).not.toContain('DO NOT LOG THIS FULL INSTRUCTION');
    expect(JSON.stringify(result.checkpoint)).not.toContain('规则 A');
    const checkpointId = progress.find(event => event.type === 'checkpoint')?.checkpoint?.id;
    expect(checkpointId).toBeDefined();
    const persistedContextCheckpoint = await readFile(join(root, '.titan', 'checkpoints', `${checkpointId}.json`), 'utf8');
    expect(persistedContextCheckpoint).not.toContain('DO NOT LOG THIS FULL INSTRUCTION');
    expect(persistedContextCheckpoint).not.toContain('规则 A');
    const digest = String(contextEvent?.payload.reference).slice('context://sha256/'.length);
    const snapshot = JSON.parse(await readFile(join(root, '.titan', 'context-snapshots', `${digest}.json`), 'utf8')) as { digest: string; references: string[]; skills: Array<{ id: string; version: string; digest: string; references: string[] }>; text: string };
    expect(snapshot).toMatchObject({ skills: [{ id: 'demo.skill', version: '1.0.0', digest: expect.stringMatching(/^sha256:/), references: ['workspace://.titan/skills/demo/instructions.md'] }] });
    expect(snapshot.text).toContain('DO NOT LOG THIS FULL INSTRUCTION');
  });

  it('preserves the exact original goal when no AGENTS.md and no lock are present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-skills-empty-'));
    roots.push(root);
    const adapter = new ContextAdapter();
    await executeDispatch(dispatch(root), { adapterFactory: () => adapter, credentialResolver: async () => 'fixture-secret', sendProgress: () => undefined });
    expect(adapter.goals).toEqual(['完成 Skill 目标']);
  });

  it('redacts JSON secret fields from returned and persisted checkpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-skills-secret-checkpoint-'));
    roots.push(root);
    await writeFile(join(root, 'AGENTS.md'), '普通项目规则', 'utf8');
    const adapter = new ContextAdapter(true);
    const secretDispatch = dispatch(root);
    secretDispatch.config.maxTurns = 2;
    secretDispatch.goal = '{"secretKey":"plaintext-value","privateKey":"private-value"}';
    const progress: RunProgress[] = [];
    const result = await executeDispatch(secretDispatch, { adapterFactory: () => adapter, credentialResolver: async () => 'fixture-secret', sendProgress: event => progress.push(event) });

    expect(result.status).toBe('waiting_input');
    expect(JSON.stringify(result.checkpoint)).not.toContain('plaintext-value');
    expect(JSON.stringify(result.checkpoint)).not.toContain('private-value');
    const checkpointId = progress.find(event => event.type === 'checkpoint')?.checkpoint?.id;
    expect(checkpointId).toBeDefined();
    const persisted = await readFile(join(root, '.titan', 'checkpoints', `${checkpointId}.json`), 'utf8');
    expect(persisted).not.toContain('plaintext-value');
    expect(persisted).not.toContain('private-value');
  });

  it('fails before the adapter can run when a caller tries to activate a skill without matching authorization', async () => {
    const { root, skillPath } = await createWorkspace();
    await writeLock(root, skillPath, { tools: ['workspace.write'] });
    const adapter = new ContextAdapter();
    const result = await executeDispatch(dispatch(root, { enabledSkills: ['demo.skill'] }, ['workspace.read']), { adapterFactory: () => adapter, credentialResolver: async () => 'fixture-secret', sendProgress: () => undefined });
    expect(result.status).toBe('failed');
    expect(adapter.configs).toHaveLength(0);
  });

  it('uses the canonical sha256 digest format for the context snapshot', async () => {
    const { root, skillPath } = await createWorkspace();
    await writeLock(root, skillPath);
    const context = await loadSkillContext({ workspacePath: root, allowedTools: ['workspace.read'], enabledSkillIds: ['demo.skill'] });
    expect(createHash('sha256').update(context?.text ?? '').digest('hex')).toBe(context?.digest.slice('sha256:'.length));
  });
});
