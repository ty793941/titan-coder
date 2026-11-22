import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DomainError } from '@titan/contracts';
import { WorkspaceManager } from './workspace-manager.js';

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_PATCH_SIZE = 4 * 1024 * 1024;
const MAX_SCAN_FILES = 10_000;
const MAX_AGGREGATE_INPUT = 32 * 1024 * 1024;
const MAX_SNAPSHOT_SIZE = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const GIT_CONFIG_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null'];
const PROTECTED_DIRECTORIES = new Set(['.git', '.titan', '.humanlayer', '.ssh', 'node_modules', 'dist', 'coverage', '.codegraph', 'logs', 'tmp', '.tmp', '.cache']);
const MINIMUM_EXCLUDES = [
  '.env*', '**/.env*', '.git/**', '**/.git/**', '.titan/**', '**/.titan/**', '.humanlayer/**', '**/.humanlayer/**',
  '.ssh/**', '**/.ssh/**', 'node_modules/**', '**/node_modules/**', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
];
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\b(?:sk-(?:proj-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{16,}|github_pat_[a-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/i,
  /(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[a-z0-9_./+=:-]{12,}/i,
];

type GitResult = { stdout: Buffer; stderr: Buffer };
type GitError = Error & { code?: number | string; stdout?: Buffer | string; stderr?: Buffer | string };

export type ExportChangesInput = {
  worktreePath: string;
  baseRevision: string;
  outputDirectory: string;
};

export type ExcludedFile = {
  path: string;
  reason: string;
};

export type SnapshotFile = {
  path: string;
  change: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  sizeBytes: number;
  checksum?: string;
  previousPath?: string;
  previousChecksum?: string;
  previousSizeBytes?: number;
  binary: boolean;
  mode?: number;
};

export type WorkspaceSnapshot = {
  schemaVersion: 1;
  repo: string;
  baseRevision: string;
  branchName: string;
  patchUri: 'patch.diff';
  patchSha: string;
  fileList: SnapshotFile[];
  excludes: string[];
  excludedFiles: ExcludedFile[];
};

export type GitEvidenceBundle = {
  bundlePath: string;
  patchPath: string;
  snapshotPath: string;
  previewPath: string;
  snapshot: WorkspaceSnapshot;
};

type BaseEntry = {
  mode: number;
  type: string;
  oid: string;
  sizeBytes: number;
  content?: Buffer;
};

type CurrentEntry = {
  absolutePath: string;
  sizeBytes: number;
  mode: number;
  content?: Buffer;
  checksum?: string;
};

type DiffStatus = {
  status: string;
  path: string;
  previousPath?: string;
};

type ScanState = { entries: number };

class ReadBudget {
  private usedBytes = 0;

  constructor(private readonly limit: number) {}

  tryReserve(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.usedBytes + bytes > this.limit) return false;
    this.usedBytes += bytes;
    return true;
  }
}

export async function exportGitEvidence(input: ExportChangesInput & { workspaceRoot: string }): Promise<GitEvidenceBundle> {
  const workspace = new WorkspaceManager([input.workspaceRoot]);
  const worktreePath = await workspace.assertAllowed(input.worktreePath);
  const outputDirectory = await workspace.assertAllowed(input.outputDirectory);
  await assertLinkedWorktree(worktreePath);
  if (isSameOrNested(worktreePath, outputDirectory)) throw conflict('output directory must be outside source worktree');
  await mkdir(outputDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const outputRoot = await realpath(outputDirectory);
  if (isSameOrNested(worktreePath, outputRoot)) throw conflict('output directory must be outside source worktree');

  const baseRevision = await validateBaseRevision(worktreePath, input.baseRevision);
  const branchName = (await runGitText(worktreePath, ['branch', '--show-current'])).trim() || 'HEAD';
  const exclusions = new Map<string, string>();
  const readBudget = new ReadBudget(MAX_AGGREGATE_INPUT);
  const baseline = await readBaseline(worktreePath, baseRevision, exclusions, readBudget);
  const sourceTrackedPaths = new Set(parseGitPathList(await runGitBuffer(worktreePath, ['ls-files', '-z'], undefined, MAX_AGGREGATE_INPUT)));
  const current = await collectCurrentFiles(worktreePath, baseline, exclusions);
  const tempRoot = await mkdtemp(join(tmpdir(), 'titan-git-evidence-'));
  await chmod(tempRoot, PRIVATE_DIRECTORY_MODE);
  const indexPath = join(tempRoot, 'index');
  const environment = { GIT_INDEX_FILE: indexPath, GIT_CONFIG_NOSYSTEM: '1' };
  let bundlePath: string | undefined;
  try {
    await runGit(worktreePath, ['read-tree', baseRevision], environment);
    const currentEntries = new Map<string, CurrentEntry>();

    for (const [path, entry] of current) {
      const base = baseline.get(path);
      const excludedReason = exclusions.get(path) ?? findParentExclusion(path, exclusions);
      if (excludedReason || !isSafeRepoPath(path)) {
        if (!excludedReason) addExclusion(exclusions, path, 'unsafe-path');
        continue;
      }
      if (base?.mode === 160000 || base?.mode === 120000) {
        addExclusion(exclusions, path, base.mode === 160000 ? 'submodule' : 'symlink');
        continue;
      }
      const readResult = await readBoundedFile(entry.absolutePath, entry.sizeBytes, readBudget);
      if (!readResult.content) {
        addExclusion(exclusions, path, readResult.reason ?? 'file-too-large');
        continue;
      }
      const content = readResult.content;
      if (containsSecret(content) || (base?.content !== undefined && containsSecret(base.content))) {
        addExclusion(exclusions, path, 'secret-pattern');
        continue;
      }
      const oid = await hashObjectFromBuffer(worktreePath, content, environment);
      const currentEntry = { ...entry, content, sizeBytes: content.length, checksum: checksum(content) };
      currentEntries.set(path, currentEntry);
      await updateIndex(worktreePath, environment, entry.mode, oid, path);
    }

    for (const [path, base] of baseline) {
      if (current.has(path)) continue;
      const excludedReason = exclusions.get(path) ?? findParentExclusion(path, exclusions);
      if (excludedReason || !isSafeRepoPath(path)) {
        if (!excludedReason) addExclusion(exclusions, path, 'unsafe-path');
        continue;
      }
      if (base.mode === 160000 || base.mode === 120000) {
        addExclusion(exclusions, path, base.mode === 160000 ? 'submodule' : 'symlink');
        continue;
      }
      if (isSensitivePath(path)) {
        addExclusion(exclusions, path, 'sensitive-filename');
        continue;
      }
      if (base.sizeBytes > MAX_FILE_SIZE) {
        addExclusion(exclusions, path, 'file-too-large');
        continue;
      }
      if (base.content !== undefined && containsSecret(base.content)) {
        addExclusion(exclusions, path, 'secret-pattern');
        continue;
      }
      await runGit(worktreePath, ['update-index', '--remove', '--', path], environment);
    }

    const patch = await runGitBuffer(worktreePath, [
      ...GIT_CONFIG_ARGS, 'diff', '--cached', '--binary', '--find-renames=50%', '--no-ext-diff', '--no-textconv', baseRevision, '--',
    ], environment, MAX_PATCH_SIZE + 1);
    if (patch.length > MAX_PATCH_SIZE) throw conflict('patch exceeds maximum size');
    if (containsSecret(patch)) throw conflict('patch contains a secret pattern');
    const statuses = parseDiffStatuses(await runGitBuffer(worktreePath, [
      ...GIT_CONFIG_ARGS, 'diff', '--cached', '--name-status', '-z', '--find-renames=50%', '--no-ext-diff', '--no-textconv', baseRevision, '--',
    ], environment));
    const fileList = buildFileList(statuses, baseline, currentEntries, sourceTrackedPaths);
    const snapshot: WorkspaceSnapshot = {
      schemaVersion: 1,
      repo: worktreePath,
      baseRevision,
      branchName,
      patchUri: 'patch.diff',
      patchSha: checksum(patch),
      fileList,
      excludes: [...MINIMUM_EXCLUDES],
      excludedFiles: [...exclusions].map(([path, reason]) => ({ path, reason })).sort((left, right) => left.path.localeCompare(right.path)),
    };
    const snapshotJson = `${JSON.stringify(snapshot, null, 2)}\n`;
    const previewJson = `${JSON.stringify({ schemaVersion: 1, files: snapshot.excludedFiles }, null, 2)}\n`;
    if (containsSecret(Buffer.from(snapshotJson)) || containsSecret(Buffer.from(previewJson))) throw conflict('snapshot summary contains a secret pattern');
    if (Buffer.byteLength(snapshotJson) + Buffer.byteLength(previewJson) > MAX_SNAPSHOT_SIZE) throw conflict('snapshot metadata exceeds maximum size');

    bundlePath = join(outputRoot, randomUUID());
    await mkdir(bundlePath, { mode: PRIVATE_DIRECTORY_MODE });
    const patchPath = join(bundlePath, 'patch.diff');
    const snapshotPath = join(bundlePath, 'snapshot.json');
    const previewPath = join(bundlePath, 'preview.json');
    await writePrivateFile(patchPath, patch);
    await writePrivateFile(snapshotPath, snapshotJson);
    await writePrivateFile(previewPath, previewJson);
    return { bundlePath, patchPath, snapshotPath, previewPath, snapshot };
  } catch (error) {
    if (bundlePath) await rm(bundlePath, { recursive: true, force: true });
    throw error instanceof DomainError ? error : conflict('git evidence export failed');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function assertLinkedWorktree(worktreePath: string): Promise<void> {
  let worktreeRoot: string;
  try {
    worktreeRoot = await realpath((await runGitText(worktreePath, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    throw conflict('path is not a Git worktree');
  }
  if (worktreeRoot !== await realpath(worktreePath)) throw conflict('worktreePath must be the linked worktree root');
  const gitDir = await realpath(resolve(worktreePath, (await runGitText(worktreePath, ['rev-parse', '--git-dir'])).trim()));
  const commonDir = await realpath(resolve(worktreePath, (await runGitText(worktreePath, ['rev-parse', '--git-common-dir'])).trim()));
  if (gitDir === commonDir || (await runGitText(worktreePath, ['rev-parse', '--is-bare-repository'])).trim() !== 'false') {
    throw conflict('source must be a linked non-bare worktree');
  }
}

async function validateBaseRevision(worktreePath: string, requested: string): Promise<string> {
  const format = (await runGitText(worktreePath, ['rev-parse', '--show-object-format'])).trim();
  const expectedLength = format === 'sha256' ? 64 : 40;
  if (!new RegExp(`^[0-9a-fA-F]{${expectedLength}}$`).test(requested)) throw conflict('baseRevision must be a complete commit object ID');
  const normalized = requested.toLowerCase();
  const resolved = (await runGitText(worktreePath, ['rev-parse', '--verify', `${normalized}^{commit}`])).trim().toLowerCase();
  if (resolved !== normalized) throw conflict('baseRevision is not a commit object ID');
  const ancestor = await runGitResult(worktreePath, ['merge-base', '--is-ancestor', normalized, 'HEAD']);
  if (ancestor.exitCode !== 0) throw conflict('baseRevision must be an ancestor of the linked worktree HEAD');
  return normalized;
}

async function readBaseline(worktreePath: string, baseRevision: string, exclusions: Map<string, string>, budget: ReadBudget): Promise<Map<string, BaseEntry>> {
  const output = await runGitBuffer(worktreePath, ['ls-tree', '-r', '-z', '--full-tree', baseRevision], undefined, MAX_AGGREGATE_INPUT);
  const records = splitNul(output);
  if (records.length > MAX_SCAN_FILES) throw conflict('baseline file count exceeds maximum');
  const rawEntries: Array<{ path: string; mode: number; type: string; oid: string }> = [];
  for (const record of records) {
    const parsed = parseTreeRecord(record);
    if (parsed) rawEntries.push(parsed);
  }
  const sizes = new Map<string, number>();
  if (rawEntries.length) {
    const sizeOutput = await runGitStdin(worktreePath, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], Buffer.from(rawEntries.map(entry => `${entry.oid}\n`).join('')));
    const sizeRecords = sizeOutput.toString('utf8').split('\n').filter(Boolean);
    if (sizeRecords.length !== rawEntries.length) throw conflict('baseline object metadata is incomplete');
    for (const record of sizeRecords) {
      const [oid, type, size] = record.split(' ');
      if (oid && type && size) sizes.set(oid, Number.parseInt(size, 10));
    }
  }
  const result = new Map<string, BaseEntry>();
  const contentEntries: Array<{ path: string; oid: string; sizeBytes: number }> = [];
  for (const entry of rawEntries) {
    const sizeBytes = sizes.get(entry.oid) ?? 0;
    const baseEntry: BaseEntry = { mode: entry.mode, type: entry.type, oid: entry.oid, sizeBytes };
    result.set(entry.path, baseEntry);
    const excludedReason = baselinePathExclusion(entry.path, entry.mode, entry.type, sizeBytes);
    if (excludedReason) {
      addExclusion(exclusions, entry.path, excludedReason);
      continue;
    }
    if (!budget.tryReserve(sizeBytes)) {
      addExclusion(exclusions, entry.path, 'aggregate-input-too-large');
      continue;
    }
    contentEntries.push({ path: entry.path, oid: entry.oid, sizeBytes });
  }
  if (contentEntries.length) {
    const contentOutput = await runGitStdin(worktreePath, ['cat-file', '--batch'], Buffer.from(contentEntries.map(entry => `${entry.oid}\n`).join('')), undefined, MAX_AGGREGATE_INPUT + 1024 * 1024);
    let offset = 0;
    for (const entry of contentEntries) {
      const headerEnd = contentOutput.indexOf(10, offset);
      if (headerEnd < 0) throw conflict('baseline object content is incomplete');
      const header = contentOutput.subarray(offset, headerEnd).toString('utf8').split(' ');
      const objectSize = Number.parseInt(header[2] ?? '', 10);
      const contentStart = headerEnd + 1;
      const contentEnd = contentStart + objectSize;
      if (!Number.isSafeInteger(objectSize) || contentEnd > contentOutput.length) throw conflict('baseline object content is incomplete');
      const content = contentOutput.subarray(contentStart, contentEnd);
      const entryValue = result.get(entry.path);
      if (entryValue) {
        entryValue.content = content;
        if (containsSecret(content)) addExclusion(exclusions, entry.path, 'secret-pattern');
      }
      offset = contentEnd + 1;
    }
  }
  return result;
}

function parseTreeRecord(record: Buffer): { path: string; mode: number; type: string; oid: string } | undefined {
  const tab = record.indexOf(9);
  if (tab < 0) return undefined;
  const header = record.subarray(0, tab).toString('utf8').split(' ');
  const modeText = header[0];
  const type = header[1];
  const oid = header[2];
  if (!modeText || !type || !oid) return undefined;
  return { path: record.subarray(tab + 1).toString('utf8'), mode: Number.parseInt(modeText, 8), type, oid };
}

function baselinePathExclusion(path: string, mode: number, type: string, sizeBytes: number): string | undefined {
  if (!isSafeRepoPath(path)) return 'unsafe-path';
  if (hasProtectedDirectory(path)) return 'protected-directory';
  if (isSensitivePath(path)) return 'sensitive-filename';
  if (mode === 160000 || type === 'commit') return 'submodule';
  if (mode === 120000) return 'symlink';
  if (type !== 'blob') return 'unsupported-file-type';
  if (sizeBytes > MAX_FILE_SIZE) return 'file-too-large';
  return undefined;
}

function hasProtectedDirectory(path: string): boolean {
  return path.split('/').some(segment => PROTECTED_DIRECTORIES.has(segment));
}

function parseGitPathList(output: Buffer): string[] {
  const paths = splitNul(output).map(value => value.toString('utf8'));
  if (paths.length > MAX_SCAN_FILES) throw conflict('Git index file count exceeds maximum');
  return paths;
}

async function collectCurrentFiles(worktreePath: string, baseline: Map<string, BaseEntry>, exclusions: Map<string, string>): Promise<Map<string, CurrentEntry>> {
  const result = new Map<string, CurrentEntry>();
  const submodules = new Set([...baseline].filter(([, entry]) => entry.mode === 160000).map(([path]) => path));
  await walk(worktreePath, worktreePath, '', result, exclusions, submodules, { entries: 0 });
  for (const [path, entry] of result) {
    if (!isSafeRepoPath(path)) addExclusion(exclusions, path, 'unsafe-path');
    else if (isSensitivePath(path)) addExclusion(exclusions, path, 'sensitive-filename');
    else if (entry.sizeBytes > MAX_FILE_SIZE) addExclusion(exclusions, path, 'file-too-large');
  }
  return result;
}

async function walk(root: string, directory: string, prefix: string, result: Map<string, CurrentEntry>, exclusions: Map<string, string>, submodules: Set<string>, scanState: ScanState): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(directory, entry.name);
    scanState.entries++;
    if (scanState.entries > MAX_SCAN_FILES) throw conflict('worktree file count exceeds maximum');
    if (PROTECTED_DIRECTORIES.has(entry.name)) {
      addExclusion(exclusions, path, 'protected-directory');
      continue;
    }
    if (submodules.has(path)) {
      addExclusion(exclusions, path, 'submodule');
      continue;
    }
    if (entry.isSymbolicLink()) {
      addExclusion(exclusions, path, 'symlink');
      continue;
    }
    if (entry.isDirectory()) {
      try {
        await lstat(join(absolutePath, '.git'));
        addExclusion(exclusions, path, 'submodule');
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const resolvedDirectory = await realpath(absolutePath);
      if (!isSameOrNested(root, resolvedDirectory)) {
        addExclusion(exclusions, path, 'symlink-escape');
        continue;
      }
      if (resolvedDirectory !== absolutePath) {
        addExclusion(exclusions, path, 'symlink');
        continue;
      }
      await walk(root, absolutePath, path, result, exclusions, submodules, scanState);
      continue;
    }
    if (!entry.isFile()) {
      addExclusion(exclusions, path, 'unsupported-file-type');
      continue;
    }
    const resolvedFile = await realpath(absolutePath);
    if (!isSameOrNested(root, resolvedFile)) {
      addExclusion(exclusions, path, 'symlink-escape');
      continue;
    }
    if (resolvedFile !== absolutePath) {
      addExclusion(exclusions, path, 'symlink');
      continue;
    }
    const fileStat = await lstat(absolutePath);
    result.set(path, { absolutePath, sizeBytes: fileStat.size, mode: fileStat.mode & 0o111 ? 100755 : 100644 });
  }
}

async function updateIndex(worktreePath: string, environment: NodeJS.ProcessEnv, mode: number, oid: string, path: string): Promise<void> {
  await runGit(worktreePath, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`], environment);
}

async function hashObjectFromBuffer(worktreePath: string, content: Buffer, environment: NodeJS.ProcessEnv): Promise<string> {
  return (await runGitStdin(worktreePath, ['hash-object', '--no-filters', '-w', '--stdin'], content, environment)).toString('utf8').trim();
}

function buildFileList(statuses: DiffStatus[], baseline: Map<string, BaseEntry>, current: Map<string, CurrentEntry>, sourceTrackedPaths: Set<string>): SnapshotFile[] {
  return statuses.map<SnapshotFile>(status => {
    const previous = status.previousPath ? baseline.get(status.previousPath) : baseline.get(status.path);
    const currentEntry = current.get(status.path);
    const isDeleted = status.status === 'D';
    const binary = Boolean(currentEntry?.content && currentEntry.content.includes(0)) || Boolean(previous?.content && previous.content.includes(0));
    if (status.status.startsWith('R') && status.previousPath) {
      return {
        path: status.path,
        change: 'renamed',
        sizeBytes: currentEntry?.sizeBytes ?? 0,
        ...(currentEntry?.checksum ? { checksum: currentEntry.checksum } : {}),
        previousPath: status.previousPath,
        ...(previous?.content ? { previousChecksum: checksum(previous.content), previousSizeBytes: previous.sizeBytes } : {}),
        binary,
        ...(currentEntry ? { mode: currentEntry.mode } : {}),
      };
    }
    const change: SnapshotFile['change'] = isDeleted ? 'deleted' : status.status === 'A' && !baseline.has(status.path) ? sourceTrackedPaths.has(status.path) ? 'added' : 'untracked' : status.status === 'A' ? 'added' : 'modified';
    return {
      path: status.path,
      change,
      sizeBytes: isDeleted ? 0 : currentEntry?.sizeBytes ?? 0,
      ...(isDeleted || !currentEntry?.checksum ? {} : { checksum: currentEntry.checksum }),
      binary,
      ...(currentEntry ? { mode: currentEntry.mode } : {}),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function parseDiffStatuses(output: Buffer): DiffStatus[] {
  const records = splitNul(output);
  const result: DiffStatus[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const tab = record.indexOf(9);
    const status = (tab < 0 ? record : record.subarray(0, tab)).toString('utf8');
    const firstPath = tab < 0 ? records[++index] : record.subarray(tab + 1);
    if (!firstPath) continue;
    const path = firstPath.toString('utf8');
    if (status.startsWith('R') || status.startsWith('C')) {
      const next = records[++index];
      if (next) result.push({ status, path: next.toString('utf8'), previousPath: path });
    } else result.push({ status, path });
  }
  return result;
}

function splitNul(buffer: Buffer): Buffer[] {
  return buffer.toString('binary').split('\0').filter(Boolean).map(value => Buffer.from(value, 'binary'));
}

async function readBoundedFile(path: string, knownSize: number, budget: ReadBudget): Promise<{ content?: Buffer; reason?: string }> {
  if (knownSize > MAX_FILE_SIZE) return { reason: 'file-too-large' };
  if (!budget.tryReserve(knownSize)) return { reason: 'aggregate-input-too-large' };
  const content = await readFile(path);
  if (content.length > MAX_FILE_SIZE) return { reason: 'file-too-large' };
  return { content };
}

async function writePrivateFile(path: string, content: string | Buffer): Promise<void> {
  await writeFile(path, content, { mode: PRIVATE_FILE_MODE });
  await chmod(path, PRIVATE_FILE_MODE);
}

function checksum(content: Buffer | string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function containsSecret(content: Buffer): boolean {
  const text = content.toString('utf8');
  return SECRET_PATTERNS.some(pattern => pattern.test(text));
}

function isSensitivePath(path: string): boolean {
  const basename = path.toLowerCase().split('/').pop() ?? '';
  return basename === '.env' || basename.startsWith('.env.') || basename === 'id_rsa' || basename === 'credentials' || basename.includes('credentials') || basename === 'password' || basename.includes('password') || basename.endsWith('.pem') || basename.endsWith('.key') || basename.endsWith('.p12') || basename.endsWith('.pfx');
}

function isSafeRepoPath(path: string): boolean {
  if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path) || /^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split('/');
  return segments.every(segment => segment && segment !== '.' && segment !== '..');
}

function findParentExclusion(path: string, exclusions: Map<string, string>): string | undefined {
  let parent = dirname(path).replaceAll('\\', '/');
  while (parent && parent !== '.') {
    const reason = exclusions.get(parent);
    if (reason) return reason;
    parent = dirname(parent).replaceAll('\\', '/');
  }
  return undefined;
}

function addExclusion(exclusions: Map<string, string>, path: string, reason: string): void {
  if (!exclusions.has(path)) exclusions.set(path, reason);
}

function isSameOrNested(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate);
  return difference === '' || (!isAbsolute(difference) && difference !== '..' && !difference.startsWith('../'));
}

function conflict(message: string): DomainError {
  return new DomainError('WORKSPACE_CONFLICT', message);
}

async function runGit(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<GitResult> {
  const result = await runGitResult(cwd, args, environment);
  if (result.exitCode !== 0) throw conflict('git command failed');
  return result;
}

async function runGitText(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<string> {
  return (await runGit(cwd, args, environment)).stdout.toString('utf8');
}

async function runGitBuffer(cwd: string, args: string[], environment?: NodeJS.ProcessEnv, maxBuffer = 16 * 1024 * 1024): Promise<Buffer> {
  const result = await runGitResult(cwd, args, environment, maxBuffer);
  if (result.exitCode !== 0) throw conflict('git command failed');
  return result.stdout;
}

async function runGitStdin(cwd: string, args: string[], input: Buffer, environment?: NodeJS.ProcessEnv, maxBuffer = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    const child = execFileCallback('git', args, {
      cwd,
      env: createGitEnvironment(environment),
      shell: false,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      maxBuffer,
      encoding: 'buffer',
    }, (error, stdout) => {
      if (error) return reject(conflict('git command failed'));
      resolveResult(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''));
    });
    child.stdin?.end(input);
  });
}

async function runGitResult(cwd: string, args: string[], environment?: NodeJS.ProcessEnv, maxBuffer = 16 * 1024 * 1024): Promise<GitResult & { exitCode: number }> {
  return new Promise(resolveResult => {
    execFileCallback('git', args, {
      cwd,
      env: createGitEnvironment(environment),
      shell: false,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      maxBuffer,
      encoding: 'buffer',
    }, (error, stdout, stderr) => {
      const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
      const errorOutput = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '');
      if (!error) return resolveResult({ stdout: output, stderr: errorOutput, exitCode: 0 });
      const gitError = error as GitError;
      const exitCode = typeof gitError.code === 'number' ? gitError.code : 1;
      resolveResult({ stdout: output, stderr: errorOutput, exitCode });
    });
  });
}

function createGitEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safeEnvironment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG']) {
    if (process.env[name] !== undefined) safeEnvironment[name] = process.env[name];
  }
  if (environment?.GIT_INDEX_FILE !== undefined) safeEnvironment.GIT_INDEX_FILE = environment.GIT_INDEX_FILE;
  safeEnvironment.GIT_CONFIG_NOSYSTEM = '1';
  safeEnvironment.GIT_ATTR_NOSYSTEM = '1';
  safeEnvironment.GIT_PAGER = 'cat';
  safeEnvironment.GIT_EDITOR = ':';
  safeEnvironment.GIT_SEQUENCE_EDITOR = ':';
  safeEnvironment.GIT_TERMINAL_PROMPT = '0';
  return safeEnvironment;
}
