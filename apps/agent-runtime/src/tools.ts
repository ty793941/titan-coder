import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { RuntimeToolSpec, ToolManifest, ToolContext } from '@titan/agent-core';

const textInput = z.object({ path: z.string().min(1) });
const writeInput = z.object({ path: z.string().min(1), content: z.string() });
const searchInput = z.object({ query: z.string().min(1), path: z.string().optional() });
const commandInput = z.object({ command: z.array(z.string()).min(1), timeoutMs: z.number().int().positive().max(120_000).optional() });
const MAX_OUTPUT = 32 * 1024;

function relativeReference(root: string, target: string, prefix: string): string {
  return `${prefix}://${relative(root, target).split(sep).join('/')}`;
}

async function safeTarget(root: string, requested: string, allowMissing: boolean): Promise<{ target: string; reference: string }> {
  if (isAbsolute(requested) || requested.includes('\0')) throw new Error('path must be relative');
  const normalizedRoot = await realpath(root);
  const target = resolve(normalizedRoot, requested);
  const targetRelative = relative(normalizedRoot, target);
  if (targetRelative.startsWith(`..${sep}`) || targetRelative === '..') throw new Error('path escapes workspace');
  const parentPath = dirname(target);
  const parentPathRelative = relative(normalizedRoot, parentPath);
  let current = normalizedRoot;
  for (const part of parentPathRelative.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('workspace path contains an unsafe parent');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
  const parent = await realpath(parentPath);
  const parentRelative = relative(normalizedRoot, parent);
  if (parentRelative.startsWith(`..${sep}`) || parentRelative === '..') throw new Error('path escapes workspace');
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) throw new Error('symlink targets are not allowed');
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { target, reference: relativeReference(normalizedRoot, target, 'workspace') };
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function search(root: string, directory: string, query: string, output: string[]): Promise<void> {
  if (output.length >= 100) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const target = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await search(root, target, query, output);
    else if (entry.isFile()) {
      const content = await readFile(target, 'utf8').catch(() => '');
      if (content.includes(query)) output.push(relativeReference(root, target, 'workspace'));
    }
  }
}

function commandAllowed(command: string[]): boolean {
  if (command[0] === 'pnpm') return command[1] === 'test' && command.length === 2;
  if (command[0] === 'node' || command[0] === process.execPath) return command[1] === '--test' && command.slice(2).every(arg => !/[;&|$`<>\n\r]/.test(arg));
  return false;
}

async function runTest(context: ToolContext, input: z.infer<typeof commandInput>): Promise<unknown> {
  if (!context.workspacePath || !commandAllowed(input.command)) throw new Error('command is not in the test allowlist');
  const executable = input.command[0];
  const args = input.command.slice(1);
  if (!executable) throw new Error('test command is empty');
  return await new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd: context.workspacePath, shell: false, env: { PATH: process.env.PATH ?? '' }, stdio: 'pipe' });
    let output = '';
    const collect = (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('test command timed out')); }, input.timeoutMs ?? 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      const passed = code === 0;
      resolveResult({ kind: 'test', reference: `test://${input.command.join(' ')}`, status: passed ? 'passed' : 'failed', output, result: passed ? 'passed' : `exit:${code ?? 'unknown'}` });
    });
  });
}

export const runtimeToolSpecs: RuntimeToolSpec[] = [
  { name: 'artifact.write', description: 'Write a reviewable artifact inside the workspace artifact directory.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'workspace.read', description: 'Read a UTF-8 file inside the authorized workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'workspace.search', description: 'Search UTF-8 files inside the authorized workspace.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'workspace.write', description: 'Atomically write a UTF-8 file inside the authorized workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'command.test', description: 'Run a bounded allowlisted test command without a shell.', inputSchema: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'number' } }, required: ['command'], additionalProperties: false } },
];

export function createRuntimeTools(): ToolManifest[] {
  return [
    {
      name: 'artifact.write', version: 1, input: writeInput,
      execute: async (raw, context) => {
        if (!context.workspacePath) throw new Error('workspace is required');
        const input = writeInput.parse(raw);
        const root = join(context.workspacePath, '.titan', 'artifacts');
        await mkdir(root, { recursive: true });
        const { target } = await safeTarget(root, input.path, true);
        await atomicWrite(target, input.content);
        return { kind: 'artifact', reference: relativeReference(await realpath(root), target, 'artifact'), checksum: checksum(input.content), output: 'written' };
      },
    },
    {
      name: 'workspace.read', version: 1, input: textInput,
      execute: async (raw, context) => {
        if (!context.workspacePath) throw new Error('workspace is required');
        const input = textInput.parse(raw);
        const { target, reference } = await safeTarget(context.workspacePath, input.path, false);
        return { reference, text: await readFile(target, 'utf8') };
      },
    },
    {
      name: 'workspace.search', version: 1, input: searchInput,
      execute: async (raw, context) => {
        if (!context.workspacePath) throw new Error('workspace is required');
        const input = searchInput.parse(raw);
        const root = context.workspacePath;
        const directory = input.path ? (await safeTarget(root, input.path, false)).target : await realpath(root);
        const matches: string[] = [];
        await search(await realpath(root), directory, input.query, matches);
        return { result: matches };
      },
    },
    {
      name: 'workspace.write', version: 1, input: writeInput,
      execute: async (raw, context) => {
        if (!context.workspacePath) throw new Error('workspace is required');
        const input = writeInput.parse(raw);
        const { target, reference } = await safeTarget(context.workspacePath, input.path, true);
        await atomicWrite(target, input.content);
        return { reference, checksum: checksum(input.content), bytes: Buffer.byteLength(input.content), output: 'written' };
      },
    },
    {
      name: 'command.test', version: 1, input: commandInput,
      execute: async (raw, context) => runTest(context, commandInput.parse(raw)),
    },
  ];
}
