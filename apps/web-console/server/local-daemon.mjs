import { spawn } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export class LocalDaemon {
  constructor(root, baseUrl) {
    this.root = root;
    this.baseUrl = baseUrl;
    this.stateDirectory = join(root, '.titan/ui-daemon', createHash('sha256').update(baseUrl).digest('hex').slice(0, 16));
    this.child = undefined;
    this.starting = undefined;
  }

  async status() {
    let daemonId;
    try { daemonId = JSON.parse(await readFile(join(this.stateDirectory, 'device.json'), 'utf8')).daemonId; } catch {}
    return { running: Boolean(this.child && this.child.exitCode === null && !this.child.killed), ...(daemonId ? { daemonId } : {}) };
  }

  async start() {
    if (this.starting) return this.starting;
    if ((await this.status()).running) return this.status();
    this.starting = this.launch();
    try { return await this.starting; } finally { this.starting = undefined; }
  }

  async launch() {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const env = {};
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG']) if (process.env[name]) env[name] = process.env[name];
    const args = [join(this.root, 'apps/daemon/dist/cli.js'), '--url', this.baseUrl, '--workspace-root', this.root, '--state-dir', this.stateDirectory];
    const candidates = [process.env.TITAN_CODEX_BINARY, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'].filter(Boolean);
    for (const binary of candidates) {
      try {
        await access(binary, constants.X_OK);
        env.TITAN_CODEX_BINARY = binary;
        args.push('--credential-env', 'TITAN_CODEX_BINARY');
        break;
      } catch {}
    }
    const child = spawn(process.execPath, args, {
      cwd: this.root, env, stdio: 'ignore',
    });
    this.child = child;
    let failed = false;
    child.once('error', () => { failed = true; });
    child.once('exit', () => { if (this.child === child) this.child = undefined; });
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      if (failed || this.child !== child) throw new Error('DAEMON_START_FAILED');
      const status = await this.status();
      if (status.daemonId) {
        try {
          const response = await fetch(`${this.baseUrl}/api/daemons/${encodeURIComponent(status.daemonId)}`, { signal: AbortSignal.timeout(1000) });
          if (response.ok && (await response.json()).status === 'ready') return status;
        } catch {}
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await this.stop();
    throw new Error('DAEMON_START_FAILED');
  }

  async stop() {
    const child = this.child;
    if (!child) return this.status();
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
    if (this.child === child) this.child = undefined;
    return this.status();
  }
}
