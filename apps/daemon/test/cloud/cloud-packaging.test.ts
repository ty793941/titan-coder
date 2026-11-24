import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const repository = new URL('../../../../', import.meta.url);
describe('cloud worker packaging', () => {
  it('pins Linux Codex and pnpm, preserves deploy dependencies and uses the actual worker entry', async () => {
    const dockerfile = await readFile(new URL('apps/agent-runtime/Dockerfile', repository), 'utf8');
    expect(dockerfile).toContain('FROM node:22');
    expect(dockerfile).toContain('pnpm@10.34.5');
    expect(dockerfile).toContain('@openai/codex@0.172.0');
    expect(dockerfile).toContain('deploy --legacy --prod');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/opt/titan/apps/agent-runtime/dist/container-worker.js"]');
    expect(dockerfile).not.toMatch(/ChatGPT\.app|HTTPS?_PROXY|7890|API_KEY/);
    const ignore = await readFile(new URL('apps/agent-runtime/Dockerfile.dockerignore', repository), 'utf8');
    expect(ignore.startsWith('**\n')).toBe(true);
    expect(ignore).toContain('!apps/agent-runtime/src/**');
    expect(ignore).not.toContain('!node_modules');
  });

  it('documents an offline cloud daemon config without environment credentials', async () => {
    const example = JSON.parse(await readFile(new URL('infra/cloud-daemon.example.json', repository), 'utf8'));
    expect(example.environmentType).toBe('cloud');
    expect(example.cloud).toMatchObject({ image: 'titan-session:phase2a', network: 'none' });
    for (const path of [example.cloud.workspaceRoot, example.cloud.snapshotRoot, ...example.workspaceRoots]) expect(path.startsWith('/')).toBe(true);
    expect(example.credentialEnv).toEqual([]);
    const guide = await readFile(new URL('infra/cloud-daemon.md', repository), 'utf8');
    expect(guide).toContain('keychain://titan-qwen');
    expect(guide).toContain('bridge');
    expect(guide).toContain('主代理');
  });

  it('copies the pinned pnpm into the final worker stage and verifies it as the worker user', async () => {
    const dockerfile = await readFile(new URL('apps/agent-runtime/Dockerfile', repository), 'utf8');
    const worker = dockerfile.split('FROM node:22-bookworm-slim AS worker\n')[1]?.split('FROM worker AS runtime')[0];
    expect(worker).toBeDefined();
    expect(worker).toContain('COPY --from=build /usr/local/lib/node_modules/pnpm /usr/local/lib/node_modules/pnpm');
    expect(worker).toContain('ln -s ../lib/node_modules/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm');
    expect(worker?.split('USER node')[1]).toContain('test "$(pnpm --version)" = "10.34.5"');
  });
});
