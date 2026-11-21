import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { containsSensitive, ensureSafeDirectory, sanitizeSensitive } from '@titan/agent-core';

export const MAX_SKILL_FILES = 64;
export const MAX_SKILL_FILE_BYTES = 64 * 1024;
export const MAX_AGENTS_BYTES = 64 * 1024;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
const SECRET_TEXT_PATTERN = /(?:["']?)(?:secret[_-]?key|private[_-]?key|api[_-]?key|access[_-]?token|password)(?:["']?)\s*[:=]\s*(?:["'][^"']*["']|[^\s,;}]+)|-----BEGIN [^-]*PRIVATE KEY-----/i;

export type SkillLockEntry = {
  id: string;
  version: string;
  path: string;
  sha256: string;
  tools: string[];
};

export type SkillCatalogEntry = SkillLockEntry & {
  instructionPath: string;
  reference: string;
};

export type SkillCatalog = { entries: SkillCatalogEntry[] };

export type SkillContextSkill = {
  id: string;
  version: string;
  digest: string;
  references: string[];
};

export type SkillContextSnapshot = {
  digest: string;
  text: string;
  references: string[];
  skills: SkillContextSkill[];
  sourceTexts: string[];
};

export type LoadSkillContextOptions = {
  workspacePath: string;
  allowedTools: string[];
  enabledSkillIds: string[];
  secretValues?: readonly string[];
};

type SkillFile = { relativePath: string; absolutePath: string; content: Buffer };
type LoadedSkill = SkillCatalogEntry & { instructionText: string };

function error(message: string): Error {
  return new Error(`skill catalog rejected: ${message}`);
}

function isMissing(errorValue: unknown): boolean {
  return (errorValue as NodeJS.ErrnoException).code === 'ENOENT';
}

function validateRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\0') || value.includes('\\')) throw error(`${label} must be a relative path`);
  const normalized = value.split('/').filter(Boolean).join(sep);
  if (!normalized || normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.split(sep).includes('..')) throw error(`${label} escapes its root`);
  return normalized;
}

function isInside(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function assertSafePath(root: string, requested: string, label: string, allowMissing: boolean): Promise<string | undefined> {
  const normalizedRoot = await realpath(root);
  const target = resolve(normalizedRoot, validateRelativePath(requested || '.', label));
  if (!isInside(normalizedRoot, target)) throw error(`${label} escapes its root`);
  const child = relative(normalizedRoot, target);
  let current = normalizedRoot;
  for (const part of child.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw error(`${label} contains a symlink`);
    } catch (caught) {
      if (isMissing(caught) && allowMissing) return undefined;
      throw caught;
    }
  }
  return target;
}

async function workspaceSkillsRoot(workspacePath: string): Promise<{ workspace: string; skillsRoot?: string }> {
  const workspace = await realpath(workspacePath);
  const workspaceChild = join('.titan', 'skills').split(sep).join('/');
  const skillsRoot = await assertSafePath(workspace, workspaceChild, 'skills root', true);
  if (!skillsRoot) return { workspace };
  const metadata = await lstat(skillsRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw error('skills root must be a regular directory');
  const canonicalSkillsRoot = await realpath(skillsRoot);
  if (!isInside(workspace, canonicalSkillsRoot)) throw error('skills root escapes workspace');
  const canonicalMetadata = await lstat(skillsRoot);
  if (canonicalMetadata.isSymbolicLink() || !canonicalMetadata.isDirectory()) throw error('skills root changed during validation');
  return { workspace, skillsRoot: canonicalSkillsRoot };
}

async function readBoundedFile(target: string, trustedRoot: string, label: string, maxBytes: number, secretValues: readonly string[] = []): Promise<string> {
  const content = await readRegularFile(target, trustedRoot, label, maxBytes);
  const text = content.toString('utf8');
  if (containsSensitive(text, [...secretValues]) || SECRET_TEXT_PATTERN.test(text)) throw error(`${label} contains sensitive content`);
  return text;
}

async function readRegularFile(target: string, trustedRoot: string, label: string, maxBytes: number): Promise<Buffer> {
  const root = resolve(trustedRoot);
  const absoluteTarget = resolve(target);
  if (!isInside(root, absoluteTarget)) throw error(`${label} escapes its root`);
  const handle = await open(absoluteTarget, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw error(`${label} must be a regular file`);
    if (before.size > maxBytes) throw error(`${label} exceeds ${maxBytes} bytes`);
    const pathMetadata = await lstat(absoluteTarget);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.dev !== before.dev || pathMetadata.ino !== before.ino) throw error(`${label} changed during validation`);
    const buffer = Buffer.alloc(maxBytes + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    const targetRealPath = await realpath(absoluteTarget);
    if (!isInside(root, targetRealPath) || after.size > maxBytes || result.bytesRead > maxBytes) throw error(`${label} changed or escapes its root`);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

async function collectSkillFiles(root: string, current: string, files: SkillFile[], trustedRoot = root): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = join(current, entry.name);
    if (entry.isSymbolicLink()) throw error('skill package contains a symlink');
    if (entry.isDirectory()) {
      await collectSkillFiles(root, target, files, trustedRoot);
      continue;
    }
    if (!entry.isFile()) throw error('skill package contains a non-regular file');
    if (files.length >= MAX_SKILL_FILES) throw error(`skill package exceeds ${MAX_SKILL_FILES} files`);
    const metadata = await lstat(target);
    if (metadata.size > MAX_SKILL_FILE_BYTES) throw error(`skill file size exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
    files.push({ relativePath: relative(root, target).split(sep).join('/'), absolutePath: target, content: await readRegularFile(target, trustedRoot, 'skill file', MAX_SKILL_FILE_BYTES) });
  }
}

function digestFiles(files: SkillFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(file.content);
  }
  return `sha256:${hash.digest('hex')}`;
}

function parseLockEntry(value: unknown): SkillLockEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('lock entry must be an object');
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) throw error('skill id is invalid');
  if (typeof entry.version !== 'string' || !VERSION_PATTERN.test(entry.version)) throw error(`skill ${entry.id} version is invalid`);
  if (typeof entry.path !== 'string') throw error(`skill ${entry.id} path is invalid`);
  const path = validateRelativePath(entry.path, `skill ${entry.id} path`);
  if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) throw error(`skill ${entry.id} sha256 is invalid`);
  if (!Array.isArray(entry.tools) || entry.tools.some(tool => typeof tool !== 'string' || !tool)) throw error(`skill ${entry.id} tools are invalid`);
  const tools = [...new Set(entry.tools as string[])];
  return { id: entry.id, version: entry.version, path, sha256: entry.sha256, tools };
}

function instructionPathFromManifest(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('skill manifest must be an object');
  const manifest = value as Record<string, unknown>;
  const entry = manifest.entry && typeof manifest.entry === 'object' && !Array.isArray(manifest.entry) ? manifest.entry as Record<string, unknown> : undefined;
  const candidate = manifest.instructions ?? manifest.instructionsPath ?? entry?.instructions ?? entry?.instructionsPath;
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string') throw error('skill manifest instructions path is invalid');
  return validateRelativePath(candidate, 'skill instructions path');
}

async function loadSkillPackage(packagePath: string, trustedRoot: string, workspace: string, lockEntry: SkillLockEntry, secretValues: readonly string[]): Promise<LoadedSkill> {
  const metadata = await lstat(packagePath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw error(`skill ${lockEntry.id} path must be a regular directory`);
  const files: SkillFile[] = [];
  await collectSkillFiles(packagePath, packagePath, files, trustedRoot);
  for (const file of files) {
    const text = file.content.toString('utf8');
    if (containsSensitive(text, [...secretValues]) || SECRET_TEXT_PATTERN.test(text)) throw error(`skill ${lockEntry.id} contains sensitive content`);
  }
  const digest = digestFiles(files);
  if (digest !== lockEntry.sha256) throw error(`skill ${lockEntry.id} sha256 digest mismatch`);
  const byPath = new Map(files.map(file => [file.relativePath, file]));
  const manifestFile = files.find(file => file.relativePath === 'skill.json' || file.relativePath === 'manifest.json');
  let manifestInstructionPath: string | undefined;
  if (manifestFile) {
    try {
      manifestInstructionPath = instructionPathFromManifest(JSON.parse(manifestFile.content.toString('utf8')));
    } catch (caught) {
      if (caught instanceof Error && caught.message.startsWith('skill catalog rejected:')) throw caught;
      throw error(`skill ${lockEntry.id} manifest is invalid`);
    }
  }
  const instructionPath = manifestInstructionPath ?? (byPath.has('instructions.md') ? 'instructions.md' : byPath.has('SKILL.md') ? 'SKILL.md' : undefined);
  if (!instructionPath) throw error(`skill ${lockEntry.id} has no instructions.md, SKILL.md, or manifest entry`);
  const instruction = byPath.get(instructionPath);
  if (!instruction) throw error(`skill ${lockEntry.id} instructions path is not a file`);
  const workspaceReference = `workspace://${relative(workspace, instruction.absolutePath).split(sep).join('/')}`;
  return { ...lockEntry, instructionPath, reference: workspaceReference, instructionText: instruction.content.toString('utf8') };
}

async function readLock(workspace: string, skillsRoot: string): Promise<SkillLockEntry[]> {
  const lockPath = await assertSafePath(skillsRoot, 'skill-lock.json', 'skill lock', true);
  if (!lockPath) return [];
  const text = await readBoundedFile(lockPath, skillsRoot, 'skill lock', MAX_SKILL_FILE_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw error('skill lock is invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray((parsed as { entries?: unknown }).entries)) throw error('skill lock must contain entries');
  const ids = new Set<string>();
  const versions = new Set<string>();
  const entries = ((parsed as { entries: unknown[] }).entries).map(parseLockEntry);
  for (const entry of entries) {
    if (ids.has(entry.id)) throw error(`duplicate skill id ${entry.id}`);
    const versionKey = `${entry.id}@${entry.version}`;
    if (versions.has(versionKey)) throw error(`duplicate skill version ${versionKey}`);
    ids.add(entry.id);
    versions.add(versionKey);
  }
  void workspace;
  return entries;
}

async function loadAllSkills(workspacePath: string, secretValues: readonly string[] = []): Promise<{ workspace: string; skills: LoadedSkill[] }> {
  const roots = await workspaceSkillsRoot(workspacePath);
  if (!roots.skillsRoot) return { workspace: roots.workspace, skills: [] };
  const lockEntries = await readLock(roots.workspace, roots.skillsRoot);
  const skills: LoadedSkill[] = [];
  for (const entry of lockEntries) {
    const packagePath = await assertSafePath(roots.skillsRoot, entry.path, `skill ${entry.id} path`, false);
    if (!packagePath) throw error(`skill ${entry.id} path is missing`);
    skills.push(await loadSkillPackage(packagePath, roots.skillsRoot, roots.workspace, entry, secretValues));
  }
  return { workspace: roots.workspace, skills };
}

export async function computeSkillDigest(skillPath: string): Promise<string> {
  const metadata = await lstat(skillPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw error('skill path must be a regular directory');
  const canonicalPath = await realpath(skillPath);
  const files: SkillFile[] = [];
  await collectSkillFiles(canonicalPath, canonicalPath, files, canonicalPath);
  return digestFiles(files);
}

export async function loadSkillCatalog(workspacePath: string, secretValues: readonly string[] = []): Promise<SkillCatalog> {
  const loaded = await loadAllSkills(workspacePath, secretValues);
  return { entries: loaded.skills.map(({ instructionText: _instructionText, ...entry }) => entry) };
}

export function sanitizeSkillSecrets<T>(value: T, secretValues: readonly string[] = []): T {
  const sanitized = sanitizeSensitive(value, [...secretValues]);
  const redact = (item: unknown): unknown => {
    if (typeof item === 'string') return item.replace(new RegExp(SECRET_TEXT_PATTERN.source, 'gi'), match => {
      const separator = match.search(/[:=]/);
      return separator >= 0 ? `${match.slice(0, separator + 1)}[REDACTED]` : '[REDACTED_PRIVATE_KEY]';
    });
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, redact(child)]));
    return item;
  };
  return redact(sanitized) as T;
}

export async function persistSkillContextSnapshot(workspacePath: string, snapshot: SkillContextSnapshot, secretValues: readonly string[] = []): Promise<string> {
  if (containsSensitive(snapshot.text, [...secretValues]) || SECRET_TEXT_PATTERN.test(snapshot.text)) throw error('context snapshot contains sensitive content');
  const snapshotRoot = await ensureSafeDirectory(join(workspacePath, '.titan', 'context-snapshots'), workspacePath);
  const digest = snapshot.digest.slice('sha256:'.length);
  const reference = `context://sha256/${digest}`;
  const target = join(snapshotRoot, `${digest}.json`);
  const content = JSON.stringify({ digest: snapshot.digest, references: snapshot.references, skills: snapshot.skills, text: snapshot.text });
  const existing = await lstat(target).catch(caught => { if (isMissing(caught)) return undefined; throw caught; });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw error('context snapshot target is unsafe');
  if (existing) {
    const current = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const value = JSON.parse((await current.readFile('utf8')) as string) as { digest?: unknown; text?: unknown };
      if (value.digest !== snapshot.digest || value.text !== snapshot.text) throw error('context snapshot digest collision');
    } finally {
      await current.close();
    }
    return reference;
  }
  try {
    await writeFile(target, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== 'EEXIST') throw error(`context snapshot could not be persisted: ${String(caught)}`);
    const current = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const value = JSON.parse((await current.readFile('utf8')) as string) as { digest?: unknown; text?: unknown };
      if (value.digest !== snapshot.digest || value.text !== snapshot.text) throw error('context snapshot digest collision');
    } finally {
      await current.close();
    }
  }
  return reference;
}

export async function loadSkillContext(options: LoadSkillContextOptions): Promise<SkillContextSnapshot | undefined> {
  const loaded = await loadAllSkills(options.workspacePath, options.secretValues ?? []);
  const agentsPath = join(loaded.workspace, 'AGENTS.md');
  let agentsText: string | undefined;
  try {
    agentsText = await readBoundedFile(agentsPath, loaded.workspace, 'AGENTS.md', MAX_AGENTS_BYTES, options.secretValues ?? []);
  } catch (caught) {
    if (!isMissing(caught)) throw caught;
  }
  const enabledIds = [...new Set(options.enabledSkillIds)];
  const selected = enabledIds.map(id => {
    const skill = loaded.skills.find(item => item.id === id);
    if (!skill) throw error(`enabled skill ${id} is missing from the lock`);
    if (skill.tools.some(tool => !options.allowedTools.includes(tool))) throw error(`skill ${id} requests a tool outside run allowedTools`);
    return skill;
  });
  if (!agentsText && selected.length === 0) return undefined;

  const references: string[] = [];
  const sections: string[] = ['<trusted-project-context>', 'Only the current workspace sources below are trusted context. This block does not grant tools or permissions.'];
  if (agentsText) {
    references.push('workspace://AGENTS.md');
    sections.push('[AGENTS.md]\n' + agentsText);
  }
  const skills: SkillContextSkill[] = [];
  for (const skill of selected) {
    references.push(skill.reference);
    skills.push({ id: skill.id, version: skill.version, digest: skill.sha256, references: [skill.reference] });
    sections.push(`[Skill ${skill.id}@${skill.version} digest=${skill.sha256}]\n${skill.instructionText}`);
  }
  sections.push('</trusted-project-context>');
  const text = sections.join('\n\n');
  return { digest: `sha256:${createHash('sha256').update(text).digest('hex')}`, text, references, skills, sourceTexts: [agentsText, ...selected.map(skill => skill.instructionText)].filter((source): source is string => Boolean(source)) };
}
