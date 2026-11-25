import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function startWorkflowWorker({ repoRoot, workerPath, controlPlaneUrl, namespace, workerId, credential, configPath: suppliedConfigPath, configDirectory: suppliedConfigDirectory }) {
  const directory = suppliedConfigDirectory ?? await mkdtemp(join(tmpdir(), 'titan-workflow-worker-'));
  const configPath = suppliedConfigPath ?? join(directory, 'worker-config.json');
  const config = {
    temporalAddress: '127.0.0.1:7233',
    namespace,
    taskQueue: 'titan-orchestration-v1',
    controlPlaneUrl,
    workerId,
    credentialRef: 'stdin://workflow',
    pollIntervalMs: 50,
    requestTimeoutMs: 2000,
  };
  if (!suppliedConfigPath) await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, [workerPath, '--config', configPath], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += String(chunk); });
  child.stderr.on('data', chunk => { logs += String(chunk); });
  child.stdin.end(credential);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    config,
    configPath,
    configDirectory: directory,
    get logs() { return logs; },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const result = await Promise.race([exited, wait(10000).then(() => undefined)]);
      if (!result && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
        throw new Error(`workflow worker did not stop after SIGTERM; logs: ${logs}`);
      }
      return result;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
