import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeTools } from '../src/tools.js';

describe('Runtime filesystem tools', () => {
  it('writes nested files atomically and returns a checksum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-tools-'));
    try {
      const tool = createRuntimeTools().find(item => item.name === 'workspace.write')!;
      const result = await tool.execute({ path: 'nested/result.txt', content: 'hello' }, { runId: 'run-1', workspacePath: root });
      expect(result).toMatchObject({ reference: 'workspace://nested/result.txt', output: 'written' });
      await expect(readFile(join(root, 'nested', 'result.txt'), 'utf8')).resolves.toBe('hello');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects traversal and symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-tools-'));
    const outside = await mkdtemp(join(tmpdir(), 'titan-outside-'));
    try {
      await symlink(outside, join(root, 'link'));
      const tool = createRuntimeTools().find(item => item.name === 'workspace.write')!;
      await expect(tool.execute({ path: '../escape.txt', content: 'bad' }, { runId: 'run-1', workspacePath: root })).rejects.toThrow('path escapes workspace');
      await expect(tool.execute({ path: 'link/escape.txt', content: 'bad' }, { runId: 'run-1', workspacePath: root })).rejects.toThrow('unsafe parent');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('runs only the bounded node test allowlist and returns test evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-tools-'));
    try {
      await writeFile(join(root, 'fixture.test.js'), "import test from 'node:test'; test('fixture', () => {});\n");
      const tool = createRuntimeTools().find(item => item.name === 'command.test')!;
      const result = await tool.execute({ command: ['node', '--test', 'fixture.test.js'] }, { runId: 'run-1', workspacePath: root }) as { kind: string; status: string };
      expect(result).toMatchObject({ kind: 'test', status: 'passed' });
      await expect(tool.execute({ command: ['sh', '-c', 'true'] }, { runId: 'run-1', workspacePath: root })).rejects.toThrow('allowlist');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes immutable UUID artifact versions with the canonical output contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-artifact-'));
    try {
      const tool = createRuntimeTools().find(item => item.name === 'artifact.write')!;
      const first = await tool.execute({ path: 'answer.txt', content: 'one' }, { runId: 'run-1', workspacePath: root }) as { reference: string; uri: string; checksum: string; artifactType: string; output: string };
      const second = await tool.execute({ path: 'answer.txt', content: 'two' }, { runId: 'run-1', workspacePath: root }) as { reference: string; uri: string };

      expect(first).toMatchObject({ artifactType: 'source-diff', output: 'written' });
      expect(first.reference).toMatch(/^artifact:\/\/[0-9a-f-]{36}\/answer\.txt$/);
      expect(first.uri).toContain(`/.titan/artifacts/${first.reference.slice('artifact://'.length).split('/')[0]}/answer.txt`);
      expect(first.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(second.reference).not.toBe(first.reference);
      await expect(stat(join(root, '.titan', 'artifacts', first.reference.slice('artifact://'.length).split('/')[0], 'answer.txt'))).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked artifact root before writing outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-artifact-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'titan-artifact-outside-'));
    try {
      await mkdir(join(root, '.titan'));
      await symlink(outside, join(root, '.titan', 'artifacts'));
      const tool = createRuntimeTools().find(item => item.name === 'artifact.write')!;
      await expect(tool.execute({ path: 'answer.txt', content: 'blocked' }, { runId: 'run-1', workspacePath: root })).rejects.toThrow(/symlink|workspace/);
      await expect(readFile(join(outside, 'answer.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not create directories during read or search and accepts search root dot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-read-'));
    try {
      const tools = createRuntimeTools();
      const read = tools.find(item => item.name === 'workspace.read')!;
      const search = tools.find(item => item.name === 'workspace.search')!;
      await expect(read.execute({ path: 'missing/child.txt' }, { runId: 'run-1', workspacePath: root })).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(join(root, 'found.txt'), 'needle');
      await expect(search.execute({ path: '.', query: 'needle' }, { runId: 'run-1', workspacePath: root })).resolves.toMatchObject({ result: ['workspace://found.txt'] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects node test imports, absolute paths, and traversal arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-command-'));
    try {
      const tool = createRuntimeTools().find(item => item.name === 'command.test')!;
      await expect(tool.execute({ command: ['node', '--test', '--import=data:text/javascript,process.exit()'] }, { runId: 'run-1', workspacePath: root })).rejects.toThrow('allowlist');
      await expect(tool.execute({ command: ['node', '--test', '/tmp/outside.test.js'] }, { runId: 'run-1', workspacePath: root })).rejects.toThrow('allowlist');
      await expect(tool.execute({ command: ['node', '--test', '../outside.test.js'] }, { runId: 'run-1', workspacePath: root })).rejects.toThrow('allowlist');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires an explicit local trusted-code policy for pnpm test', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-pnpm-'));
    try {
      const tool = createRuntimeTools().find(item => item.name === 'command.test')!;
      await expect(tool.execute({ command: ['pnpm', 'test'] }, { runId: 'run-1', workspacePath: root })).rejects.toThrow('trusted');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves an existing workspace file mode across atomic writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-mode-'));
    try {
      const target = join(root, 'mode.txt');
      await writeFile(target, 'old', { mode: 0o640 });
      const tool = createRuntimeTools().find(item => item.name === 'workspace.write')!;
      await tool.execute({ path: 'mode.txt', content: 'new' }, { runId: 'run-1', workspacePath: root });
      expect((await stat(target)).mode & 0o777).toBe(0o640);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks exact credentials and private key patterns before writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-secret-'));
    try {
      const tool = createRuntimeTools().find(item => item.name === 'artifact.write')!;
      await expect(tool.execute({ path: 'secret.txt', content: 'qwen-secret' }, { runId: 'run-1', workspacePath: root, secretValues: ['qwen-secret'] })).rejects.toThrow(/secret/);
      await expect(tool.execute({ path: '.env', content: 'OPENAI_API_KEY=sk-test-value' }, { runId: 'run-1', workspacePath: root })).rejects.toThrow(/secret/);
      await expect(tool.execute({ path: 'key.txt', content: '-----BEGIN PRIVATE KEY-----' }, { runId: 'run-1', workspacePath: root })).rejects.toThrow(/secret/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds read output and search work for large files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-large-files-'));
    try {
      await writeFile(join(root, 'large.txt'), 'needle'.repeat(100_000));
      const tools = createRuntimeTools();
      const read = tools.find(item => item.name === 'workspace.read')!;
      const search = tools.find(item => item.name === 'workspace.search')!;
      const result = await read.execute({ path: 'large.txt' }, { runId: 'run-1', workspacePath: root }) as { text: string };
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(32 * 1024);
      const matches = await search.execute({ query: 'needle', path: '.' }, { runId: 'run-1', workspacePath: root }) as { result: string[] };
      expect(matches.result).toEqual(['workspace://large.txt']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
