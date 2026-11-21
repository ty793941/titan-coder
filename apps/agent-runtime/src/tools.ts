import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { containsSensitive, containsSensitivePath, ensureSafeDirectory } from '@titan/agent-core';
import type { RuntimeToolSpec, ToolManifest, ToolContext } from '@titan/agent-core';

const textInput = z.object({ path: z.string().min(1) });
const artifactInput = z.object({ path: z.string().min(1), content: z.string(), artifactType: z.enum(['source-diff', 'test-report', 'spec', 'review', 'release-package']).default('source-diff') });
const writeInput = z.object({ path: z.string().min(1), content: z.string() });
const searchInput = z.object({ query: z.string().min(1), path: z.string().optional() });
const commandInput = z.object({ command: z.array(z.string()).min(1), timeoutMs: z.number().int().positive().max(120_000).optional() });
const MAX_OUTPUT = 32 * 1024;
const MAX_SEARCH_BYTES = 1024 * 1024;
const TEST_FILE_PATTERN = /(?:^|[./])[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function relativeReference(root: string, target: string, prefix: string): string {
  return `${prefix}://${relative(root, target).split(sep).join('/')}`;
}

async function safeTarget(root: string, requested: string, allowMissing: boolean, createParents: boolean): Promise<{ target: string; reference: string }> {
  if (isAbsolute(requested) || requested.includes('\0')) throw new Error('path must be relative');
  const normalizedRoot = await realpath(root);
  const target = resolve(normalizedRoot, requested);
  const targetRelative = relative(normalizedRoot, target);
  if (targetRelative.startsWith(`..${sep}`) || targetRelative === '..') throw new Error('path escapes workspace');
  if (target === normalizedRoot) return { target, reference: relativeReference(normalizedRoot, target, 'workspace') };
  const parentPath = dirname(target);
  const parentPathRelative = relative(normalizedRoot, parentPath);
  let current = normalizedRoot;
  for (const part of parentPathRelative.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('workspace path contains an unsafe parent');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !createParents) throw error;
      await mkdir(current, { mode: 0o700 });
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
  const existing = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  const mode = existing && !existing.isSymbolicLink() ? existing.mode & 0o777 : 0o600;
  const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function checksum(content: string): string { return `sha256:${createHash('sha256').update(content).digest('hex')}`; }

function rejectUnsafeWrite(input: { path: string; content: string }, context: ToolContext): void {
  if (containsSensitive(input, context.secretValues) || containsSensitivePath(input)) throw new Error('secret content or sensitive path is blocked');
}

async function search(root: string, directory: string, query: string, output: string[], budget: { bytes: number }): Promise<void> {
  if (output.length >= 100 || budget.bytes >= MAX_SEARCH_BYTES || Buffer.byteLength(JSON.stringify(output)) >= MAX_OUTPUT) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const target = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await search(root, target, query, output, budget);
    else if (entry.isFile()) {
      const metadata = await stat(target);
      if (metadata.size > MAX_SEARCH_BYTES - budget.bytes) continue;
      const content = await readFile(target, 'utf8').catch(() => '');
      budget.bytes += Buffer.byteLength(content);
      if (content.includes(query)) output.push(relativeReference(root, target, 'workspace'));
      if (output.length >= 100 || budget.bytes >= MAX_SEARCH_BYTES || Buffer.byteLength(JSON.stringify(output)) >= MAX_OUTPUT) return;
    }
  }
}

function commandAllowed(command: string[]): boolean {
  if (command[0] === 'pnpm') return command.length === 2 && command[1] === 'test';
  if (command[0] === 'node' || command[0] === process.execPath) return command[1] === '--test' && command.length > 2 && command.slice(2).every(arg => !arg.startsWith('-') && !arg.includes(':') && !isAbsolute(arg) && !arg.split(/[\\/]/).includes('..'));
  return false;
}

function killGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { child.kill(signal); }
}

async function validateNodeTestFiles(root: string, args: string[]): Promise<void> {
  for (const arg of args) {
    if (!TEST_FILE_PATTERN.test(arg)) throw new Error('node --test arguments must be workspace-relative test files');
    const target = await safeTarget(root, arg, false, false);
    const metadata = await lstat(target.target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('node --test argument is not a regular file');
  }
}

async function runTest(context: ToolContext, input: z.infer<typeof commandInput>): Promise<unknown> {
  if (!context.workspacePath || !commandAllowed(input.command)) throw new Error('command is not in the test allowlist');
  const executable = input.command[0];
  const args = input.command.slice(1);
  if (!executable) throw new Error('test command is empty');
  if (executable === 'pnpm' && context.trustedCode !== true) throw new Error('pnpm test requires explicit trusted-code local policy');
  if (executable === 'node' || executable === process.execPath) await validateNodeTestFiles(context.workspacePath, input.command.slice(2));
  return await new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, args, { cwd: context.workspacePath, shell: false, detached: process.platform !== 'win32', env: { PATH: process.env.PATH ?? '' }, stdio: 'pipe' });
    let output = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const collect = (chunk: Buffer) => { output = Buffer.from(`${output}${chunk.toString('utf8')}`).subarray(-MAX_OUTPUT).toString('utf8'); };
    const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(hardTimer); context.signal?.removeEventListener('abort', abort); callback(); };
    const terminate = () => { killGroup(child, 'SIGTERM'); forceTimer = setTimeout(() => { killGroup(child, 'SIGKILL'); hardTimer = setTimeout(() => finish(() => rejectResult(new Error('test command termination timed out'))), 500); }, 250); };
    const abort = () => { aborted = true; terminate(); };
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => { timedOut = true; terminate(); }, input.timeoutMs ?? 30_000);
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    context.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => finish(() => rejectResult(error)));
    child.once('close', code => finish(() => {
      if (aborted) return rejectResult(new Error('test command aborted'));
      if (timedOut) return rejectResult(new Error('test command timed out'));
      const passed = code === 0;
      resolveResult({ kind: 'test', reference: `test://${input.command.join(' ')}`, status: passed ? 'passed' : 'failed', output, result: passed ? 'passed' : `exit:${code ?? 'unknown'}` });
    }));
  });
}

export const runtimeToolSpecs: RuntimeToolSpec[] = [
  { name: 'artifact.write', description: 'Write a reviewable artifact inside the workspace artifact directory.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, artifactType: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'workspace.read', description: 'Read a UTF-8 file inside the authorized workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'workspace.search', description: 'Search UTF-8 files inside the authorized workspace.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'workspace.write', description: 'Atomically write a UTF-8 file inside the authorized workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'command.test', description: 'Run a bounded allowlisted test command without a shell.', inputSchema: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'number' } }, required: ['command'], additionalProperties: false } },
];

export function createRuntimeTools(): ToolManifest[] {
  return [
    {
      name: 'artifact.write', version: 1, input: artifactInput,
      execute: async (raw, context) => {
        if (!context.workspacePath) throw new Error('workspace is required');
        const input = artifactInput.parse(raw);
        rejectUnsafeWrite(input, context);
        const artifactRoot = await ensureSafeDirectory(join(context.workspacePath, '.titan', 'artifacts'), context.workspacePath);
        const version = randomUUID();
        const versionRoot = join(artifactRoot, version);
        await mkdir(versionRoot, { mode: 0o700 });
        const { target } = await safeTarget(versionRoot, input.path, true, true);
        await atomicWrite(target, input.content);
        return { kind: 'artifact', reference: relativeReference(artifactRoot, target, 'artifact'), uri: pathToFileURL(target).href, checksum: checksum(input.content), artifactType: input.artifactType, output: 'written' };
      },
    },
    {
      name: 'workspace.read', version: 1, input: textInput,
      execute: async (raw, context) => {
        if (!context.workspacePath) throw new Error('workspace is required');
        const input = textInput.parse(raw);
        const { target, reference } = await safeTarget(context.workspacePath, input.path, false, false);
        const content = await readFile(target, 'utf8');
        return { reference, text: Buffer.from(content).subarray(0, MAX_OUTPUT).toString('utf8') };
      },
    },
    {
      name: 'workspace.search', version: 1, input: searchInput,
      execute: async (raw, context) => {
        if (!context.workspacePath) throw new Error('workspace is required');
        const input = searchInput.parse(raw);
        const root = await realpath(context.workspacePath);
        const directory = input.path ? (await safeTarget(root, input.path, false, false)).target : root;
        const matches: string[] = [];
        await search(root, directory, input.query, matches, { bytes: 0 });
        return { result: matches };
      },
    },
    {
      name: 'workspace.write', version: 1, input: writeInput,
      execute: async (raw, context) => {
        if (!context.workspacePath) throw new Error('workspace is required');
        const input = writeInput.parse(raw);
        rejectUnsafeWrite(input, context);
        const { target, reference } = await safeTarget(context.workspacePath, input.path, true, true);
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
