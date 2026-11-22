import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../src/test-app.js';

describe('Artifact content boundary', () => {
  let api: Awaited<ReturnType<typeof createTestApp>>;
  let workspace: string;
  let root: string;
  let sessionId: string;
  const namespace = randomUUID();
  const token = randomUUID();
  const originalToken = process.env.TITAN_CONSOLE_TOKEN;
  let version = 0;
  const checksum = (content: string | Buffer) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
  beforeAll(async () => {
    process.env.TITAN_CONSOLE_TOKEN = token;
    api = await createTestApp();
    workspace = await mkdtemp(join(tmpdir(), 'titan-content-'));
    root = join(workspace, '.titan', 'artifacts', namespace);
    await mkdir(root, { recursive: true });
    const session = await api.post('/api/tasks/task_dev/sessions').set('Idempotency-Key', randomUUID())
      .send({ entryAgent: 'project-manager', goal: 'Read content' }).expect(201);
    sessionId = session.body.id;
    await api.db.updateTable('session').set({ execution_config: JSON.stringify({ workspacePath: workspace }) }).where('id', '=', sessionId).execute();
  });
  afterAll(async () => {
    await api?.close();
    if (originalToken === undefined) delete process.env.TITAN_CONSOLE_TOKEN;
    else process.env.TITAN_CONSOLE_TOKEN = originalToken;
  });
  const content = (id: string) => api.get(`/api/artifacts/${id}/content`).set('Authorization', `Bearer ${token}`);
  async function register(path: string, value: string | Buffer, session: string | null = sessionId) {
    const id = `artifact_${randomUUID()}`;
    await api.db.insertInto('artifact').values({ artifact_id: id, project_id: 'project_dev', task_id: 'task_dev', session_id: session,
      type: 'source-diff', version: ++version, schema_version: 1, uri: pathToFileURL(path).toString(), checksum: checksum(value), status: 'draft',
      source_artifacts: JSON.stringify([]), created_by_type: 'agent', created_by_id: 'test', created_at: new Date(), review_state: 'pending',
      reference: `artifact://${namespace}/${path.split('/').at(-1)}`, metadata: {} }).execute();
    return id;
  }

  it('reads a real control-plane-created Markdown artifact and checks byte checksum', async () => {
    const value = '# Plan\n验收内容\n';
    const artifact = await api.post('/api/tasks/task_dev/artifacts').set('Idempotency-Key', randomUUID()).send({ type: 'plan', content: value }).expect(201);
    await api.get(`/api/artifacts/${artifact.body.artifactId}/content`).expect(401);
    const response = await content(artifact.body.artifactId).expect(200);
    expect(response.body).toEqual({ content: value, format: 'markdown', checksum: checksum(value), bytes: Buffer.byteLength(value) });
  });

  it.each([['result.json', '{"ok":true}', 'json'], ['result.txt', 'plain text', 'text'], ['result.md', '# Result', 'markdown']])('reads workspace artifact %s', async (name, value, format) => {
    const path = join(root, name);
    await writeFile(path, value);
    const response = await content(await register(path, value)).expect(200);
    expect(response.body).toEqual({ content: value, format, checksum: checksum(value), bytes: Buffer.byteLength(value) });
  });

  it('rejects a forged Markdown URI outside the artifact whitelist', async () => {
    const path = join(workspace, 'credentials.md');
    await writeFile(path, 'not public');
    const response = await content(await register(path, 'not public')).expect(403);
    expect(response.body.code).toBe('PERMISSION_DENIED');
    expect(JSON.stringify(response.body)).not.toContain('not public');
  });

  it('rejects a symlinked file escaping the artifact root', async () => {
    const path = join(root, 'escape.md');
    const outside = join(workspace, 'outside.md');
    await writeFile(outside, 'outside secret');
    await symlink(outside, path);
    expect((await content(await register(path, 'outside secret')).expect(403)).body.code).toBe('PERMISSION_DENIED');
  });

  it('rejects a symlinked artifact directory escaping the workspace', async () => {
    const other = await mkdtemp(join(tmpdir(), 'titan-content-outside-'));
    await mkdir(join(other, '.titan'), { recursive: true });
    await symlink(join(workspace, '.titan', 'artifacts'), join(other, '.titan', 'artifacts'));
    const session = await api.post('/api/tasks/task_dev/sessions').set('Idempotency-Key', randomUUID())
      .send({ entryAgent: 'project-manager', goal: 'Symlink boundary' }).expect(201);
    await api.db.updateTable('session').set({ execution_config: JSON.stringify({ workspacePath: other }) }).where('id', '=', session.body.id).execute();
    const path = join(other, '.titan', 'artifacts', namespace, 'root-escape.md');
    await writeFile(join(root, 'root-escape.md'), 'outside root');
    expect((await content(await register(path, 'outside root', session.body.id)).expect(403)).body.code).toBe('PERMISSION_DENIED');
  });

  it('rejects files over 2 MiB with a stable reason before returning content', async () => {
    const value = Buffer.alloc(2 * 1024 * 1024 + 1, 'a');
    const path = join(root, 'large.md');
    await writeFile(path, value);
    const response = await content(await register(path, value)).expect(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'ARTIFACT_CONTENT_TOO_LARGE', maxBytes: 2097152 } });
  });

  it('rejects tampered content', async () => {
    const path = join(root, 'tampered.md');
    await writeFile(path, 'tampered');
    const response = await content(await register(path, 'original')).expect(409);
    expect(response.body).toMatchObject({ code: 'VERSION_CONFLICT', details: { reason: 'ARTIFACT_CHECKSUM_MISMATCH' } });
  });

  it('rejects cross-task session metadata even for a control-plane file', async () => {
    const artifact = await api.post('/api/tasks/task_dev/artifacts').set('Idempotency-Key', randomUUID()).send({ type: 'plan', content: '# Safe' }).expect(201);
    const task = await api.post('/api/projects/project_dev/tasks').set('Idempotency-Key', randomUUID())
      .send({ title: 'Other task', goal: 'Boundary', acceptanceCriteria: ['No cross-task access'], priority: 'high' }).expect(201);
    const session = await api.post(`/api/tasks/${task.body.id}/sessions`).set('Idempotency-Key', randomUUID())
      .send({ entryAgent: 'project-manager', goal: 'Other session' }).expect(201);
    await api.db.updateTable('artifact').set({ session_id: session.body.id }).where('artifact_id', '=', artifact.body.artifactId).execute();
    expect((await content(artifact.body.artifactId).expect(403)).body.code).toBe('PERMISSION_DENIED');
  });

  it('rejects metadata borrowing another control-plane artifact file even with a matching checksum', async () => {
    const original = await api.post('/api/tasks/task_dev/artifacts').set('Idempotency-Key', randomUUID())
      .send({ type: 'plan', content: '# Private original' }).expect(201);
    const forged = await api.post('/api/tasks/task_dev/artifacts').set('Idempotency-Key', randomUUID())
      .send({ type: 'plan', content: '# Forged reference' }).expect(201);
    await api.db.updateTable('artifact').set({ uri: 'file:///unavailable-original.md' }).where('artifact_id', '=', original.body.artifactId).execute();
    await api.db.updateTable('artifact').set({ uri: original.body.uri, checksum: original.body.checksum }).where('artifact_id', '=', forged.body.artifactId).execute();
    expect((await content(forged.body.artifactId).expect(403)).body.code).toBe('PERMISSION_DENIED');
  });

  it('rejects a workspace URI that does not match its runtime artifact reference', async () => {
    const path = join(root, 'wrong-reference.md');
    await writeFile(path, 'borrowed file');
    const id = await register(path, 'borrowed file');
    await api.db.updateTable('artifact').set({ reference: `artifact://${namespace}/different-file.md` }).where('artifact_id', '=', id).execute();
    expect((await content(id).expect(403)).body.code).toBe('PERMISSION_DENIED');
  });

  it('returns 404 for missing metadata and missing files, rejects non-file URIs and unsupported formats', async () => {
    expect((await content('artifact_missing').expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
    expect((await content(await register(join(root, 'missing.md'), '')).expect(404)).body.code).toBe('RESOURCE_NOT_FOUND');
    const html = join(root, 'page.html');
    await writeFile(html, '<script>alert(1)</script>');
    expect((await content(await register(html, '<script>alert(1)</script>')).expect(400)).body.code).toBe('VALIDATION_FAILED');
    const id = await register(join(root, 'remote.md'), '');
    await api.db.updateTable('artifact').set({ uri: 'https://example.com/secret.md' }).where('artifact_id', '=', id).execute();
    expect((await content(id).expect(403)).body.code).toBe('PERMISSION_DENIED');
  });
});
