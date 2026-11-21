import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
});
