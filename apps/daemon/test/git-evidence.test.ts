import { execFile as execFileCallback } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeManager, type GitEvidenceBundle } from '../src/main.js';

const execFile = promisify(execFileCallback);
const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true });
});

async function git(cwd: string, args: string[], input?: string | Buffer): Promise<string> {
  const result = await execFile('git', args, { cwd, input, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}

async function gitTree(cwd: string): Promise<string> {
  return (await git(cwd, ['write-tree'])).trim();
}

async function setupRepository(): Promise<{ root: string; repositoryPath: string; manager: WorktreeManager; worktreePath: string; baseRevision: string }> {
  const root = await mkdtemp(join(tmpdir(), 'titan-git-evidence-'));
  cleanups.push(root);
  const repositoryPath = join(root, 'repository');
  await mkdir(repositoryPath);
  await git(repositoryPath, ['init', '-q']);
  await git(repositoryPath, ['config', 'user.email', 'titan@example.com']);
  await git(repositoryPath, ['config', 'user.name', 'Titan']);
  await writeFile(join(repositoryPath, 'tracked.txt'), 'base\n');
  await writeFile(join(repositoryPath, 'delete.txt'), 'delete me\n');
  await writeFile(join(repositoryPath, 'rename.txt'), 'rename me\n');
  await writeFile(join(repositoryPath, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
  await git(repositoryPath, ['add', '--all']);
  await git(repositoryPath, ['commit', '-qm', 'initial']);
  const baseRevision = (await git(repositoryPath, ['rev-parse', 'HEAD'])).trim();
  const manager = new WorktreeManager(root);
  const worktree = await manager.create({ repositoryPath, branchName: 'task/git-evidence' });
  return { root, repositoryPath, manager, worktreePath: worktree.path, baseRevision };
}

async function expectRejected(action: Promise<unknown>, code = 'WORKSPACE_CONFLICT'): Promise<void> {
  await expect(action).rejects.toMatchObject({ code });
}

describe('WorktreeManager.exportChanges', () => {
  it('exports staged and unstaged changes without changing either Git index', async () => {
    const fixture = await setupRepository();
    const { repositoryPath, manager, worktreePath, baseRevision, root } = fixture;

    await writeFile(join(worktreePath, 'tracked.txt'), 'staged\n');
    await git(worktreePath, ['add', '--', 'tracked.txt']);
    await writeFile(join(worktreePath, 'tracked.txt'), 'staged and unstaged\n');
    await writeFile(join(worktreePath, 'staged-added.txt'), 'staged addition\n');
    await git(worktreePath, ['add', '--', 'staged-added.txt']);
    const repositoryIndexBefore = await gitTree(repositoryPath);
    const worktreeIndexBefore = await gitTree(worktreePath);

    const bundle = await manager.exportChanges({ worktreePath, baseRevision, outputDirectory: join(root, 'bundles') });
    const files = new Map(bundle.snapshot.fileList.map(file => [file.path, file]));

    expect(bundle.snapshot.schemaVersion).toBe(1);
    expect(bundle.snapshot.repo).toBe(worktreePath);
    expect(bundle.snapshot.baseRevision).toBe(baseRevision);
    expect(bundle.snapshot.patchUri).toBe('patch.diff');
    expect(bundle.snapshot.excludes).toEqual(expect.arrayContaining(['.env*', '.git/**', '.titan/**', '.humanlayer/**', '.ssh/**', 'node_modules/**']));
    expect(files.get('tracked.txt')).toMatchObject({ change: 'modified', sizeBytes: Buffer.byteLength('staged and unstaged\n') });
    expect(files.get('staged-added.txt')).toMatchObject({ change: 'added', sizeBytes: Buffer.byteLength('staged addition\n') });
    expect(await gitTree(repositoryPath)).toBe(repositoryIndexBefore);
    expect(await gitTree(worktreePath)).toBe(worktreeIndexBefore);
  });

  it('distinguishes committed and staged additions from an untracked addition', async () => {
    const fixture = await setupRepository();
    const { manager, worktreePath, baseRevision, root } = fixture;
    await writeFile(join(worktreePath, 'head-added.txt'), 'committed after baseline\n');
    await git(worktreePath, ['add', '--', 'head-added.txt']);
    await git(worktreePath, ['commit', '-qm', 'head addition']);
    await writeFile(join(worktreePath, 'staged-added.txt'), 'staged after baseline\n');
    await git(worktreePath, ['add', '--', 'staged-added.txt']);
    await writeFile(join(worktreePath, 'untracked-added.txt'), 'untracked after baseline\n');
    const worktreeIndexBefore = await gitTree(worktreePath);

    const bundle = await manager.exportChanges({ worktreePath, baseRevision, outputDirectory: join(root, 'bundles') });
    const files = new Map(bundle.snapshot.fileList.map(file => [file.path, file]));
    expect(files.get('head-added.txt')).toMatchObject({ change: 'added' });
    expect(files.get('staged-added.txt')).toMatchObject({ change: 'added' });
    expect(files.get('untracked-added.txt')).toMatchObject({ change: 'untracked' });
    expect(await gitTree(worktreePath)).toBe(worktreeIndexBefore);
  });

  it('exports binary, rename, delete, Unicode, and literal-dash paths as an applicable patch', async () => {
    const fixture = await setupRepository();
    const { repositoryPath, manager, worktreePath, baseRevision, root } = fixture;
    await writeFile(join(worktreePath, 'tracked.txt'), 'staged and unstaged\n');
    await git(worktreePath, ['mv', '--', 'rename.txt', 'renamed.txt']);
    await rm(join(worktreePath, 'delete.txt'));
    await writeFile(join(worktreePath, '-literal name.txt'), 'dash path\n');
    await writeFile(join(worktreePath, '空 格.txt'), 'unicode path\n');
    await writeFile(join(worktreePath, 'new-binary.bin'), Buffer.from([0, 255, 1, 0]));
    await writeFile(join(worktreePath, 'binary.bin'), Buffer.from([0, 2, 3, 0, 255]));

    const bundle = await manager.exportChanges({ worktreePath, baseRevision, outputDirectory: join(root, 'bundles') });
    const patch = await readFile(bundle.patchPath);
    const files = new Map(bundle.snapshot.fileList.map(file => [file.path, file]));

    expect(bundle.snapshot.patchSha).toBe(`sha256:${createHash('sha256').update(patch).digest('hex')}`);
    expect(patch.toString('utf8')).toContain('GIT binary patch');
    expect(files.get('renamed.txt')).toMatchObject({ change: 'renamed', previousPath: 'rename.txt' });
    expect(files.get('delete.txt')).toMatchObject({ change: 'deleted', sizeBytes: 0 });
    expect(files.get('-literal name.txt')).toMatchObject({ change: 'untracked' });
    expect(files.get('空 格.txt')).toMatchObject({ change: 'untracked' });
    expect(files.get('new-binary.bin')).toMatchObject({ change: 'untracked', binary: true });

    const patchStat = await stat(bundle.patchPath);
    const snapshotStat = await stat(bundle.snapshotPath);
    const previewStat = await stat(bundle.previewPath);
    expect(patchStat.mode & 0o777).toBe(0o600);
    expect(snapshotStat.mode & 0o777).toBe(0o600);
    expect(previewStat.mode & 0o777).toBe(0o600);

    const applyRepository = join(root, 'apply-repository');
    await git(root, ['clone', '-q', repositoryPath, applyRepository]);
    await git(applyRepository, ['checkout', '-q', baseRevision]);
    await git(applyRepository, ['apply', '--check', bundle.patchPath]);
    await git(applyRepository, ['apply', '--binary', bundle.patchPath]);
    expect(await readFile(join(applyRepository, 'tracked.txt'), 'utf8')).toBe('staged and unstaged\n');
    expect(await readFile(join(applyRepository, 'renamed.txt'), 'utf8')).toBe('rename me\n');
    await expect(access(join(applyRepository, 'rename.txt'))).rejects.toThrow();
    await expect(access(join(applyRepository, 'delete.txt'))).rejects.toThrow();
    expect(await readFile(join(applyRepository, 'new-binary.bin'))).toEqual(Buffer.from([0, 255, 1, 0]));
  });

  it('keeps secrets out of patch and records local exclusion metadata separately from proto excludes', async () => {
    const fixture = await setupRepository();
    const { manager, worktreePath, baseRevision, root, repositoryPath } = fixture;
    await writeFile(join(worktreePath, 'baseline-secret.txt'), 'OPENAI_API_KEY=sk-proj-baseline-secret-value\n');
    await git(worktreePath, ['add', '--', 'baseline-secret.txt']);
    await git(worktreePath, ['commit', '-qm', 'baseline secret']);
    const secretBaseRevision = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(worktreePath, 'baseline-secret.txt'), 'redacted\n');
    await writeFile(join(worktreePath, '.env.example'), 'OPENAI_API_KEY=sk-example-secret-value\n');
    await writeFile(join(worktreePath, 'ordinary.txt'), 'DASHSCOPE_API_KEY=secret-value-that-must-not-ship\n');
    await mkdir(join(worktreePath, '.titan'));
    await writeFile(join(worktreePath, '.titan', 'state.json'), '{"token":"private"}\n');
    await symlink('tracked.txt', join(worktreePath, 'link.txt'));
    const submoduleRepository = join(root, 'submodule-repository');
    await mkdir(submoduleRepository);
    await git(submoduleRepository, ['init', '-q']);
    await git(submoduleRepository, ['config', 'user.email', 'titan@example.com']);
    await git(submoduleRepository, ['config', 'user.name', 'Titan']);
    await writeFile(join(submoduleRepository, 'nested.txt'), 'submodule content\n');
    await git(submoduleRepository, ['add', '--all']);
    await git(submoduleRepository, ['commit', '-qm', 'submodule']);
    await git(worktreePath, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', submoduleRepository, 'vendor/submodule']);
    await git(repositoryPath, ['config', 'diff.external', join(root, 'must-not-run.sh')]);
    await writeFile(join(root, 'must-not-run.sh'), '#!/bin/sh\ntouch ' + join(root, 'external-ran') + '\n');
    await chmod(join(root, 'must-not-run.sh'), 0o700);
    await writeFile(join(worktreePath, '.gitattributes'), 'filtered.txt filter=blocked\n');
    await writeFile(join(worktreePath, 'filtered.txt'), 'filter must not execute\n');
    await writeFile(join(root, 'must-not-filter.sh'), '#!/bin/sh\ntouch ' + join(root, 'filter-ran') + '\ncat\n');
    await chmod(join(root, 'must-not-filter.sh'), 0o700);
    await git(repositoryPath, ['config', 'filter.blocked.clean', join(root, 'must-not-filter.sh')]);

    const bundle = await manager.exportChanges({ worktreePath, baseRevision: secretBaseRevision, outputDirectory: join(root, 'bundles') });
    const patch = await readFile(bundle.patchPath, 'utf8');
    const preview = await readFile(bundle.previewPath, 'utf8');
    const excluded = bundle.snapshot.excludedFiles;
    expect(bundle.snapshot.excludes).toEqual(expect.arrayContaining(['.env*', '.git/**', '.titan/**', '.humanlayer/**', '.ssh/**', 'node_modules/**', '**/*.pem', '**/*.key']));
    expect(patch).not.toContain('OPENAI_API_KEY');
    expect(patch).not.toContain('DASHSCOPE_API_KEY');
    expect(preview).not.toContain('sk-proj-baseline-secret-value');
    expect(preview).not.toContain('secret-value-that-must-not-ship');
    expect(excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'baseline-secret.txt' }),
      expect.objectContaining({ path: '.env.example' }),
      expect.objectContaining({ path: 'ordinary.txt' }),
      expect.objectContaining({ path: '.titan', reason: 'protected-directory' }),
      expect.objectContaining({ path: 'link.txt', reason: 'symlink' }),
      expect.objectContaining({ path: 'vendor/submodule', reason: 'submodule' }),
    ]));
    await expect(access(join(root, 'external-ran'))).rejects.toThrow();
    await expect(access(join(root, 'filter-ran'))).rejects.toThrow();
  });

  it('excludes sensitive parent directories before walking ignored files', async () => {
    const fixture = await setupRepository();
    const { manager, worktreePath, baseRevision, root } = fixture;
    await writeFile(join(worktreePath, '.gitignore'), 'credentials/\n.env.local/\n');
    await mkdir(join(worktreePath, 'credentials'));
    await mkdir(join(worktreePath, '.env.local'));
    await writeFile(join(worktreePath, 'credentials', 'session.json'), '{"token":"ignored-secret"}\n');
    await writeFile(join(worktreePath, '.env.local', 'config.json'), '{"apiKey":"ignored-secret"}\n');

    const bundle = await manager.exportChanges({ worktreePath, baseRevision, outputDirectory: join(root, 'bundles') });
    const patch = await readFile(bundle.patchPath, 'utf8');
    const excludedPaths = new Map(bundle.snapshot.excludedFiles.map(file => [file.path, file.reason]));
    expect(patch).not.toContain('session.json');
    expect(patch).not.toContain('config.json');
    expect(excludedPaths.get('credentials')).toBe('sensitive-directory');
    expect(excludedPaths.get('.env.local')).toBe('sensitive-directory');

    const oldSensitiveFixture = await setupRepository();
    await writeFile(join(oldSensitiveFixture.worktreePath, 'credentials'), 'old credential target\n');
    await git(oldSensitiveFixture.worktreePath, ['add', '--', 'credentials']);
    await git(oldSensitiveFixture.worktreePath, ['commit', '-qm', 'sensitive old file']);
    const oldSensitiveBaseRevision = (await git(oldSensitiveFixture.worktreePath, ['rev-parse', 'HEAD'])).trim();
    await rm(join(oldSensitiveFixture.worktreePath, 'credentials'));
    await mkdir(join(oldSensitiveFixture.worktreePath, 'credentials'));
    await writeFile(join(oldSensitiveFixture.worktreePath, 'credentials', 'session.json'), 'new credential target\n');
    const oldSensitiveBundle = await oldSensitiveFixture.manager.exportChanges({ worktreePath: oldSensitiveFixture.worktreePath, baseRevision: oldSensitiveBaseRevision, outputDirectory: join(oldSensitiveFixture.root, 'bundles-old') });
    expect(oldSensitiveBundle.snapshot.fileList.find(file => file.path === 'credentials')).toBeUndefined();
    expect(await readFile(oldSensitiveBundle.patchPath, 'utf8')).not.toContain('credential target');
  });

  it('never exports a committed symlink deletion or replacement', async () => {
    const fixture = await setupRepository();
    const { manager, worktreePath, root } = fixture;
    await symlink('tracked.txt', join(worktreePath, 'committed-link'));
    await git(worktreePath, ['add', '--', 'committed-link']);
    await git(worktreePath, ['commit', '-qm', 'commit symlink']);
    const symlinkBaseRevision = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();

    await rm(join(worktreePath, 'committed-link'));
    const deletedBundle = await manager.exportChanges({ worktreePath, baseRevision: symlinkBaseRevision, outputDirectory: join(root, 'bundles-delete') });
    expect(deletedBundle.snapshot.fileList.find(file => file.path === 'committed-link')).toBeUndefined();
    expect(await readFile(deletedBundle.patchPath, 'utf8')).not.toContain('committed-link');

    await writeFile(join(worktreePath, 'committed-link'), 'replacement must not ship\n');
    const replacedBundle = await manager.exportChanges({ worktreePath, baseRevision: symlinkBaseRevision, outputDirectory: join(root, 'bundles-replace') });
    expect(replacedBundle.snapshot.fileList.find(file => file.path === 'committed-link')).toBeUndefined();
    expect(await readFile(replacedBundle.patchPath, 'utf8')).not.toContain('replacement must not ship');
  });

  it('normalizes host diff configuration so the patch keeps stable prefixes and applies', async () => {
    const fixture = await setupRepository();
    const { repositoryPath, manager, worktreePath, baseRevision, root } = fixture;
    await writeFile(join(worktreePath, 'tracked.txt'), 'host config must not change patch\n');
    for (const [key, value] of [['color.ui', 'always'], ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['diff.relative', 'true'], ['diff.renames', 'false']] as const) {
      await git(repositoryPath, ['config', key, value]);
    }

    const bundle = await manager.exportChanges({ worktreePath, baseRevision, outputDirectory: join(root, 'bundles') });
    const patch = await readFile(bundle.patchPath, 'utf8');
    expect(patch).not.toMatch(/\u001b\[/);
    expect(patch).toContain('diff --git a/tracked.txt b/tracked.txt');
    expect(patch).toContain('--- a/tracked.txt');
    expect(patch).toContain('+++ b/tracked.txt');

    const applyRepository = join(root, 'apply-repository');
    await git(root, ['clone', '-q', repositoryPath, applyRepository]);
    await git(applyRepository, ['checkout', '-q', baseRevision]);
    await git(applyRepository, ['apply', '--check', bundle.patchPath]);
  });

  it('handles file-directory transitions in both directions and an empty replacement directory', async () => {
    const fileFixture = await setupRepository();
    const filePath = join(fileFixture.worktreePath, 'config');
    await writeFile(filePath, 'file before directory\n');
    await git(fileFixture.worktreePath, ['add', '--', 'config']);
    await git(fileFixture.worktreePath, ['commit', '-qm', 'config file']);
    const fileBaseRevision = (await git(fileFixture.worktreePath, ['rev-parse', 'HEAD'])).trim();
    await rm(filePath);
    await mkdir(filePath);
    await writeFile(join(filePath, 'index.ts'), 'directory after file\n');
    const fileToDirectory = await fileFixture.manager.exportChanges({ worktreePath: fileFixture.worktreePath, baseRevision: fileBaseRevision, outputDirectory: join(fileFixture.root, 'bundles-file-to-directory') });
    expect(fileToDirectory.snapshot.fileList).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'config', change: 'deleted' }),
      expect.objectContaining({ path: 'config/index.ts', change: 'untracked' }),
    ]));

    const directoryFixture = await setupRepository();
    await mkdir(join(directoryFixture.worktreePath, 'config'));
    await writeFile(join(directoryFixture.worktreePath, 'config', 'index.ts'), 'directory before file\n');
    await git(directoryFixture.worktreePath, ['add', '--', 'config/index.ts']);
    await git(directoryFixture.worktreePath, ['commit', '-qm', 'config directory']);
    const directoryBaseRevision = (await git(directoryFixture.worktreePath, ['rev-parse', 'HEAD'])).trim();
    await rm(join(directoryFixture.worktreePath, 'config'), { recursive: true, force: true });
    await writeFile(join(directoryFixture.worktreePath, 'config'), 'file after directory\n');
    const directoryToFile = await directoryFixture.manager.exportChanges({ worktreePath: directoryFixture.worktreePath, baseRevision: directoryBaseRevision, outputDirectory: join(directoryFixture.root, 'bundles-directory-to-file') });
    expect(directoryToFile.snapshot.fileList).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'config/index.ts', change: 'deleted' }),
      expect.objectContaining({ path: 'config', change: 'untracked' }),
    ]));

    const emptyFixture = await setupRepository();
    await writeFile(join(emptyFixture.worktreePath, 'emptydir'), 'tracked before empty directory\n');
    await git(emptyFixture.worktreePath, ['add', '--', 'emptydir']);
    await git(emptyFixture.worktreePath, ['commit', '-qm', 'empty directory transition']);
    const emptyBaseRevision = (await git(emptyFixture.worktreePath, ['rev-parse', 'HEAD'])).trim();
    await rm(join(emptyFixture.worktreePath, 'emptydir'));
    await mkdir(join(emptyFixture.worktreePath, 'emptydir'));
    const emptyBundle = await emptyFixture.manager.exportChanges({ worktreePath: emptyFixture.worktreePath, baseRevision: emptyBaseRevision, outputDirectory: join(emptyFixture.root, 'bundles-empty') });
    expect(emptyBundle.snapshot.fileList).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'emptydir', change: 'deleted' })]));
  });

  it('rejects nested, source-local, non-linked, and abbreviated worktree locations before creating output', async () => {
    const fixture = await setupRepository();
    const { manager, worktreePath, baseRevision, root, repositoryPath } = fixture;
    await expectRejected(manager.exportChanges({ worktreePath: join(worktreePath, 'nested'), baseRevision, outputDirectory: join(root, 'bundles-1') }));
    await expectRejected(manager.exportChanges({ worktreePath, baseRevision, outputDirectory: join(worktreePath, 'bundles-2') }));
    await expectRejected(manager.exportChanges({ worktreePath: repositoryPath, baseRevision, outputDirectory: join(root, 'bundles-3') }));
    await expectRejected(manager.exportChanges({ worktreePath, baseRevision: baseRevision.slice(0, -1), outputDirectory: join(root, 'bundles-4') }));
    await expect(access(join(worktreePath, 'bundles-2'))).rejects.toThrow();
  });

  it('rejects a complete revision that is not an ancestor of the linked worktree HEAD', async () => {
    const fixture = await setupRepository();
    const { manager, worktreePath, root, repositoryPath, baseRevision } = fixture;
    const unrelatedRevision = (await git(repositoryPath, ['-c', 'user.email=titan@example.com', '-c', 'user.name=Titan', 'commit-tree', `${baseRevision}^{tree}`, '-m', 'unrelated'])).trim();
    await expectRejected(manager.exportChanges({ worktreePath, baseRevision: unrelatedRevision, outputDirectory: join(root, 'bundles') }));
  });

  it('reports private bundle files and enforces local snapshot metadata limits', async () => {
    const fixture = await setupRepository();
    const { manager, worktreePath, baseRevision, root } = fixture;
    const bundle = await manager.exportChanges({ worktreePath, baseRevision, outputDirectory: join(root, 'bundles') });
    const [patchStat, snapshotStat, previewStat] = await Promise.all([stat(bundle.patchPath), stat(bundle.snapshotPath), stat(bundle.previewPath)]);
    expect(patchStat.mode & 0o777).toBe(0o600);
    expect(snapshotStat.mode & 0o777).toBe(0o600);
    expect(previewStat.mode & 0o777).toBe(0o600);
    expect(Buffer.byteLength(await readFile(bundle.snapshotPath, 'utf8'))).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(bundle.snapshot.excludedFiles.every(file => !('content' in file))).toBe(true);
  });
});

type _CompileContract = GitEvidenceBundle;
