import { constants, openSync, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, readdirSync, readSync, writeSync, fsyncSync, renameSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { containsSensitive, containsSensitivePath, containsUnsafePath } from '@titan/agent-core';
import type { CloudSnapshotFile, CloudSnapshotFileMode, CloudSnapshotManifest } from './types.js';

export type { CloudSnapshotManifest } from './types.js';

const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 32 * MAX_FILE;
const MAX_FILES = 10_000;
const MAX_PACKAGE = 64 * MAX_FILE;
const excludedNames = new Set(['.git', '.titan', '.humanlayer', '.codegraph', 'node_modules', 'dist', 'coverage', 'credentials', '.ssh', '.aws', '.gnupg', '.npmrc', '.netrc']);
const sourceExtensions = new Set([
  'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'cs', 'dart', 'ex', 'exs', 'erl', 'fs', 'fsx', 'go', 'groovy', 'hbs', 'hs', 'java', 'jl', 'js', 'jsx', 'json5', 'kt', 'kts', 'less', 'lua', 'm', 'mm', 'mjs', 'mts', 'php', 'pl', 'pm', 'ps1', 'py', 'rb', 'rs', 'rust', 'scala', 'scss', 'sh', 'sql', 'svelte', 'swift', 't', 'tf', 'ts', 'tsx', 'vb', 'vue', 'xml', 'yaml', 'yml', 'zsh',
]);
const noFollow = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW;
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function fail(kind: string): never { throw new Error(`CLOUD_SNAPSHOT_${kind}`); }
const inside = (root: string, path: string) => { const child = relative(root, path); return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); };
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

function excluded(path: string): boolean {
  const parts = path.split('/');
  const filename = parts.at(-1) ?? '';
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : '';
  const isSourceFile = sourceExtensions.has(extension);
  const credentialData = /(?:^|[-_.])(?:auth|keys?|tokens?|secrets?|passwords?|credentials?|api[-_]?keys?|private[-_]?keys?|service[-_]?accounts?)(?:[-_.]|$)/i.test(filename)
    && /\.(?:json5?|xml|ya?ml|toml|ini|conf|config|txt|csv|properties)$/i.test(filename);
  return containsSensitivePath(path) || parts.some(part => excludedNames.has(part) || part.startsWith('.env')
    || /(?:^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|\.(?:pem|key|p12|pfx|keystore)$)/i.test(part))
    || credentialData
    || (!isSourceFile && /(?:^|[-_.])(?:auth|keys?|tokens?|secrets?|passwords?|credentials?|api[-_]?keys?|private[-_]?keys?|service[-_]?accounts?)(?:[-_.]|$)/i.test(filename));
}

function safeRelative(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 1024 && !containsUnsafePath(path)
    && !path.startsWith('/') && !path.includes('\\') && !/[\x00-\x1f\x7f:]/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function inDirectory<T>(fd: number, path: string, operation: (anchor: string) => T): T {
  if (process.platform === 'linux') return operation(`/proc/self/fd/${fd}`);
  // macOS 的 /dev/fd 不支持目录相对访问。同步区段固定内核 cwd 后核验 inode，
  // 所有操作仅使用单层相对路径；区段内禁止 await，退出前恢复并核验原 cwd。
  const previous = process.cwd();
  const previousIdentity = lstatSync('.');
  try {
    process.chdir(path);
    if (!same(fstatSync(fd), lstatSync('.'))) fail('PATH');
    return operation('.');
  } finally {
    process.chdir(previous);
    if (!same(previousIdentity, lstatSync('.')) || !same(fstatSync(fd), lstatSync(path))) fail('CHANGED');
  }
}

function withDirectory<T>(path: string, operation: (anchor: string) => T): T {
  const fd = directory(path);
  try { return inDirectory(fd, path, operation); }
  finally { closeSync(fd); }
}

export function assertCloudDirectory(path: string): string {
  const absolute = resolve(path);
  let cursor: string = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    const metadata = lstatSync(cursor);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('PATH');
  }
  return absolute;
}

function directory(path: string): number {
  if (process.platform === 'linux' && /^\/proc\/self\/fd\/\d+(?:\/|$)/.test(path)) {
    const [anchor, suffix] = path.match(/^(\/proc\/self\/fd\/\d+)(.*)$/)!.slice(1);
    let current = anchor!;
    for (const part of suffix!.split('/').filter(Boolean)) {
      current += `/${part}`;
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('PATH');
    }
  } else assertCloudDirectory(path);
  const before = lstatSync(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | noFollow);
  try {
    if (!same(before, fstatSync(fd)) || !same(before, lstatSync(path))) fail('PATH');
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

function readBytes(path: string, limit: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('PATH');
  if (before.size > limit) fail('LIMIT');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  try {
    const start = fstatSync(fd);
    if (!same(start, before) || !start.isFile()) fail('PATH');
    if (start.size > limit) fail('LIMIT');
    const bytes = Buffer.alloc(start.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (n === 0) break;
      size += n;
    }
    const end = fstatSync(fd);
    if (size > limit) fail('LIMIT');
    if (size !== start.size || start.size !== end.size || start.mtimeMs !== end.mtimeMs || start.ctimeMs !== end.ctimeMs || !same(end, lstatSync(path))) fail('CHANGED');
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}

function writeNew(path: string, bytes: Uint8Array, mode = 0o600): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    fchmodSync(fd, mode);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

type SnapshotMode = CloudSnapshotFileMode;
interface SnapshotPackage { schemaVersion: 1; snapshotId: string; baseRevision: string; files: CloudSnapshotFile[] }

export class LocalSnapshotStore {
  private readonly root: string;
  private readonly rootIdentity: Stats;
  private readonly workspaceRoots: { path: string; identity: Stats }[];

  constructor(options: { root: string; workspaceRoots: string[] }) {
    try {
      this.workspaceRoots = options.workspaceRoots.map(root => {
        const path = assertCloudDirectory(root);
        const identity = lstatSync(path);
        if (identity.uid !== process.getuid?.() || (identity.mode & 0o022) !== 0) fail('PATH');
        return { path, identity };
      });
      this.root = resolve(options.root);
      assertCloudDirectory(dirname(this.root));
      withDirectory(dirname(this.root), anchor => {
        try { mkdirSync(`${anchor}/${basename(this.root)}`, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      });
      assertCloudDirectory(this.root);
      const metadata = lstatSync(this.root);
      if ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) fail('PATH');
      this.rootIdentity = metadata;
    } catch { fail('PATH'); }
  }

  async exportWorkspace(workspacePath: string): Promise<CloudSnapshotManifest> {
    try {
      const source = assertCloudDirectory(workspacePath);
      this.authorize(source);
      if (source === this.root || inside(this.root, source)) fail('PATH');
      let baseRevision: string;
      try {
        const revision = execFileSync('git', ['-C', source, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', timeout: 5000, maxBuffer: 256, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) fail('REVISION');
        baseRevision = revision;
      } catch { fail('REVISION'); }
      const files: CloudSnapshotFile[] = [];
      let totalBytes = 0;
      const walk = (path: string, prefix: string, depth: number): void => {
        if (depth > 64) fail('LIMIT');
        const fd = directory(path);
        const before = fstatSync(fd);
        try {
          inDirectory(fd, path, anchor => {
            for (const name of readdirSync(anchor).sort()) {
              const child = prefix ? `${prefix}/${name}` : name;
              if (excluded(child)) continue;
              if (!safeRelative(child)) fail('PATH');
              const target = `${anchor}/${name}`;
              const info = lstatSync(target);
              if (info.isSymbolicLink()) continue;
              if (info.isDirectory() && same(info, this.rootIdentity)) continue;
              if (info.isDirectory()) walk(target, child, depth + 1);
              else if (info.isFile()) {
                if (files.length >= MAX_FILES) fail('LIMIT');
                const bytes = readBytes(target, MAX_FILE);
                if (containsSensitive(bytes.toString('utf8')) || containsSensitive(bytes.toString('utf16le'))) fail('SENSITIVE');
                totalBytes += bytes.length;
                if (totalBytes > MAX_TOTAL) fail('LIMIT');
                files.push({ path: child, content: bytes.toString('base64'), mode: (info.mode & 0o100) === 0o100 ? 0o100 : 0 });
              } else fail('PATH');
            }
          });
          const after = fstatSync(fd);
          if (!same(before, lstatSync(path)) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('CHANGED');
        } finally { closeSync(fd); }
      };
      walk(source, '', 0);
      this.authorize(source);
      const snapshotId = randomUUID();
      const pack: SnapshotPackage = { schemaVersion: 1, snapshotId, baseRevision, files };
      const bytes = Buffer.from(JSON.stringify(pack));
      if (bytes.length > MAX_PACKAGE) fail('LIMIT');
      const fd = this.openStore();
      try { inDirectory(fd, this.root, anchor => writeNew(`${anchor}/${snapshotId}.json`, bytes)); } finally { closeSync(fd); }
      return { schemaVersion: 1, snapshotId, baseRevision, checksum: hash(bytes), fileCount: files.length, totalBytes };
    } catch (error) { this.safeError(error); }
  }

  async materialize(manifest: CloudSnapshotManifest, destination: string): Promise<void> {
    try {
      this.validateManifest(manifest);
      const fd = this.openStore();
      let bytes: Buffer;
      try { bytes = inDirectory(fd, this.root, anchor => readBytes(`${anchor}/${manifest.snapshotId}.json`, MAX_PACKAGE)); } finally { closeSync(fd); }
      if (hash(bytes) !== manifest.checksum) fail('CHECKSUM');
      let pack: SnapshotPackage;
      try { pack = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID'); }
      if (!pack || pack.schemaVersion !== 1 || pack.snapshotId !== manifest.snapshotId || pack.baseRevision !== manifest.baseRevision || !Array.isArray(pack.files) || pack.files.length !== manifest.fileCount) fail('INVALID');
      const decoded: { path: string; bytes: Buffer; mode: SnapshotMode }[] = [];
      const paths = new Set<string>();
      let total = 0;
      for (const file of pack.files) {
        if (!file || !safeRelative(file.path) || excluded(file.path) || paths.has(file.path) || typeof file.content !== 'string') fail('INVALID');
        if (file.mode !== undefined && file.mode !== 0 && file.mode !== 0o100) fail('INVALID');
        if (file.content.length > 4 * Math.ceil(MAX_FILE / 3)) fail('LIMIT');
        const content = Buffer.from(file.content, 'base64');
        if (content.toString('base64') !== file.content) fail('INVALID');
        if (content.length > MAX_FILE) fail('LIMIT');
        if (containsSensitive(content.toString('utf8')) || containsSensitive(content.toString('utf16le'))) fail('SENSITIVE');
        paths.add(file.path);
        total += content.length;
        if (total > MAX_TOTAL) fail('LIMIT');
        decoded.push({ path: file.path, bytes: content, mode: file.mode ?? 0 });
      }
      for (const path of paths) {
        const parts = path.split('/');
        parts.pop();
        while (parts.length) { if (paths.has(parts.join('/'))) fail('INVALID'); parts.pop(); }
      }
      if (total !== manifest.totalBytes) fail('INVALID');
      const target = resolve(destination);
      this.authorize(dirname(target));
      if (!this.workspaceRoots.some(root => inside(root.path, target)) || target === this.root || inside(this.root, target)) fail('PATH');
      const parent = directory(dirname(target));
      try {
        this.authorize(dirname(target));
        // 0700/0600 的目录和文件由宿主 UID 拥有；Docker 必须使用相同非 root UID:GID。
        inDirectory(parent, dirname(target), parentAnchor => {
          const targetPath = `${parentAnchor}/${basename(target)}`;
          try { lstatSync(targetPath); fail('PATH'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const staging = `${parentAnchor}/.titan-snapshot-${randomUUID()}`;
          mkdirSync(staging, { mode: 0o700 });
          withDirectory(staging, anchor => {
            const write = (parts: string[], currentAnchor: string, bytes: Buffer, mode: SnapshotMode): void => {
              const name = parts[0]!;
              if (parts.length === 1) { writeNew(`${currentAnchor}/${name}`, bytes, mode === 0o100 ? 0o700 : 0o600); return; }
              const child = `${currentAnchor}/${name}`;
              try { mkdirSync(child, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
              withDirectory(child, childAnchor => write(parts.slice(1), childAnchor, bytes, mode));
            };
            for (const file of decoded) write(file.path.split('/'), anchor, file.bytes, file.mode);
          });
          if (!same(fstatSync(parent), lstatSync(dirname(target)))) fail('CHANGED');
          // 先独占预留空目录，再原子替换；失败的私有 staging 留待显式回收。
          mkdirSync(targetPath, { mode: 0o700 });
          renameSync(staging, targetPath);
        });
      } finally { closeSync(parent); }
    } catch (error) { this.safeError(error); }
  }

  private validateManifest(value: CloudSnapshotManifest): void {
    if (!value || value.schemaVersion !== 1 || typeof value.snapshotId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.snapshotId)
      || typeof value.checksum !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.checksum)
      || typeof value.baseRevision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseRevision)
      || !Number.isInteger(value.fileCount) || value.fileCount < 0 || value.fileCount > MAX_FILES
      || !Number.isInteger(value.totalBytes) || value.totalBytes < 0 || value.totalBytes > MAX_TOTAL) fail('INVALID');
  }

  private authorize(path: string): void {
    const root = this.workspaceRoots.find(root => path === root.path || inside(root.path, path));
    if (!root || !same(root.identity, lstatSync(root.path))) fail('PATH');
    assertCloudDirectory(path);
    let current = root.path;
    for (const part of ['', ...relative(root.path, path).split(sep).filter(Boolean)]) {
      if (part) current = resolve(current, part);
      const info = lstatSync(current);
      if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) fail('PATH');
    }
  }

  private openStore(): number {
    const fd = directory(this.root);
    const info = fstatSync(fd);
    if (!same(info, this.rootIdentity) || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) { closeSync(fd); fail('PATH'); }
    return fd;
  }

  private safeError(error: unknown): never {
    if (error instanceof Error && /^CLOUD_SNAPSHOT_[A-Z]+$/.test(error.message)) throw error;
    fail('PATH');
  }
}
